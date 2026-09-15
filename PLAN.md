# Terminus — Kế hoạch xây dựng SSH Manager (giống Termius)

> Ứng dụng quản lý SSH/SFTP chạy trên Linux (Ubuntu), UI đẹp như Termius nhưng nhẹ như native.
> Stack: **Tauri + Rust** (backend) + **React + TypeScript** (frontend).

---

## 1. Hiện trạng môi trường

| Thành phần | Trạng thái | Ghi chú |
|-----------|-----------|---------|
| Ubuntu 22.04.5 LTS | ✅ | OK |
| Node v22 / npm 10 / pnpm 11 | ✅ | Dùng cho frontend |
| Rust / Cargo | ❌ chưa có | Cần cài qua rustup |
| Tauri CLI | ❌ chưa có | Cài sau khi có Rust |
| webkit2gtk-4.1 + build deps | ❌ chưa có | Gói hệ thống cho Tauri |

---

## 2. Phạm vi MVP (đã chốt)

- [x] SSH terminal + quản lý host
- [x] SFTP file browser
- [x] SSH key management
- [x] Port forwarding & jump host
- [x] **Đồng bộ cloud qua GitHub (git-based vault, E2E encryption)**
- [x] **Password manager (vault riêng: group/entry/search, generator, TOTP, liên kết SSH host)**

Ngoài phạm vi MVP (cân nhắc sau): OAuth device flow cho GitHub, sync đa máy per-item, import/export .kdbx, mobile app, team sharing.

---

## 3. Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────┐
│  Frontend (WebView) — React + TypeScript          │
│  • xterm.js (terminal)  • UI quản lý host/SFTP    │
│  • Tailwind + shadcn/ui (giao diện giống Termius) │
└───────────────┬───────────────────────────────────┘
                │  Tauri IPC (commands + events)
┌───────────────┴───────────────────────────────────┐
│  Backend (Rust) — tauri core                       │
│  • russh        → kết nối SSH, PTY, channel        │
│  • russh-sftp   → SFTP                             │
│  • portable-pty → gắn luồng terminal               │
│  • sqlx+SQLite  → lưu host/group/key/snippet       │
│  • ssh-key      → tạo/parse SSH key                │
│  • keyring      → lưu secret vào OS keychain       │
│  • sync module  → mã hóa E2E + GitHub API          │
└───────────────────────────────────────────────────┘
```

### Quyết định kỹ thuật quan trọng
- **Luồng terminal qua Tauri events**, không qua HTTP. PTY stream về frontend bằng `emit`; frontend gửi keystroke xuống bằng `invoke`.
- **Mật khẩu/passphrase KHÔNG lưu plaintext** → dùng `keyring` (OS keychain) hoặc mã hóa bằng master password. Metadata host lưu SQLite.
- **Mỗi phiên SSH = 1 task async riêng** (tokio), quản lý bằng `SessionManager` giữ map `session_id → handle`.
- **Host key verification** (known_hosts) bắt buộc để tránh MITM.

---

## 3b. Đồng bộ cloud qua GitHub (git-based vault)

Không dựng backend riêng — dùng **repo GitHub private của người dùng** làm nơi lưu trữ. Tool
chỉ đẩy lên blob **đã mã hóa E2E**, GitHub không bao giờ đọc được nội dung.

```
         Máy A                                    Máy B (cài lại)
  ┌──────────────────┐                       ┌──────────────────┐
  │ Data (host/key)  │                       │  (trống)         │
  │       ↓ mã hóa   │                       │       ↑ giải mã  │
  │  vault.enc       │                       │  vault.enc       │
  └────────┬─────────┘                       └────────▲─────────┘
           │ push (GitHub API)                        │ pull
           └──────────────►  GitHub private repo  ◄───┘
                            (chỉ chứa ciphertext)
```

### Mô hình mã hóa (zero-knowledge)
```
Master password (CHỈ ở máy, không bao giờ rời thiết bị)
        │ Argon2id (salt lưu kèm vault)
        ▼
   Encryption key  ──►  XChaCha20-Poly1305  ──►  vault.enc (ciphertext + nonce + salt)
```
- Toàn bộ data (host, group, password, private key, snippet) serialize → JSON → mã hóa → `vault.enc`.
- Cài lại máy: nhập PAT → pull `vault.enc` → nhập master password → giải mã local.
- **Quên master password = mất data** (không ai khôi phục được). Thêm *recovery code* tùy chọn để giảm rủi ro.

### Xác thực GitHub
- MVP: **Personal Access Token (fine-grained)**, chỉ cấp quyền cho đúng repo vault.
- PAT lưu trong **OS keychain** (không lưu plaintext, không commit lên repo).
- Tương lai: OAuth device flow (không cần dán token thủ công).

### Giao tiếp GitHub
- Dùng **GitHub Contents API** (`GET`/`PUT /repos/{owner}/{repo}/contents/vault.enc`) qua `reqwest` —
  không cần clone git cục bộ. Mỗi lần `PUT` là một commit (tự có version history).
- Repo do người dùng nhập vào tool (ví dụ `username/terminus-vault`); tool tự tạo nếu chưa có.

### Định dạng & xung đột
- MVP: **một file `vault.enc`**, chiến lược last-write-wins.
- Luôn **pull trước khi push**; nếu SHA remote khác SHA local đã biết → cảnh báo xung đột, không ghi đè mù.
- Nâng cấp sau: per-item file (`hosts/<id>.enc`…) để merge mượt khi dùng nhiều máy.

### Luồng người dùng
1. Settings → Cloud Sync → dán PAT + tên repo.
2. Đặt master password (tạo lần đầu) → tool tạo repo nếu cần, push `vault.enc`.
3. Mỗi khi data đổi → auto-encrypt + push (có debounce). Nút "Sync now" thủ công.
4. Máy mới: đăng nhập PAT → chọn repo → nhập master password → khôi phục toàn bộ.

---

## 3c. SFTP đa endpoint & chuyển file giữa các server

Nâng cấp SFTP từ "Local ↔ 1 server" (kiểu Termius) lên **dual-pane chọn endpoint tự do**.

```
┌───────── Pane trái ─────────┐   ┌───────── Pane phải ─────────┐
│ Endpoint: [ Local      ▾]   │   │ Endpoint: [ server-B   ▾]   │
│  ~/home/minhngoc            │ ⇄ │  /var/www                   │
│  ├─ Downloads/              │   │  ├─ app/                    │
│  └─ project.zip     12 MB   │──►│  └─ ...                     │
└─────────────────────────────┘   └─────────────────────────────┘
   Mỗi dropdown = Local + mọi server đã lưu → chọn A bên trái, B bên phải
```

### Các trường hợp chuyển
| Nguồn → Đích | Cơ chế |
|--------------|--------|
| Local → Server | SFTP upload trực tiếp |
| Server → Local | SFTP download trực tiếp |
| **Server A → Server B** | **Relay-streaming qua local**: mở SFTP read stream trên A, ghi thẳng vào SFTP write stream trên B theo từng chunk (buffer nhỏ, không tạo file tạm full-size) |

- **Nâng cao (sau MVP):** direct A→B (chạy `scp`/`rsync` từ A sang B) khi 2 server thấy nhau — nhanh hơn, không qua băng thông local.

### Transfer queue
- Mọi thao tác chuyển đẩy vào **hàng đợi** chạy nền (tokio task), không chặn UI duyệt file.
- Mỗi job phát event tiến trình (bytes/giây, %, ETA) về frontend qua Tauri `emit`.
- Hỗ trợ nhiều job song song (giới hạn concurrency), **hủy** và **retry**.
- Chuyển thư mục = đệ quy liệt kê rồi enqueue từng file, giữ nguyên cây thư mục.

### Tương tác
- Kéo-thả file/thư mục giữa 2 pane để chuyển; hoặc chọn rồi nút "Transfer →".
- Đổi endpoint ở dropdown → mở SFTP session mới (tái dùng SSH session nếu server đó đang kết nối).

---

## 3d. Settings — giao diện, theme & hành vi

Cửa sổ Settings dạng sidebar (giống Termius), gom các nhóm cấu hình. Lưu vào bảng
`settings` trong SQLite (key-value) + **được đưa vào vault sync** (mục 3b) để cài lại máy là có luôn.

### Nhóm cấu hình

**Appearance (App)**
- Theme app: **Auto / Light / Dark** (Auto = theo hệ điều hành)
- Ngôn ngữ (VI/EN) — tùy chọn sau

**Terminal**
- Font family (mặc định *Source Code Pro*, cho chọn monospace cài trên máy)
- Text size (nút − / + , mặc định 14)
- Terminal emulation type (`xterm-256color`…)
- Toggle hành vi:
  - Autoreconnect (tự kết nối lại khi rớt)
  - Import shell history
  - Select text to copy & right-click to paste
  - Bell sound
  - Use bright colours for bold text
  - Autocomplete (beta — để sau)

**Terminal theme** (bảng màu cho xterm.js)
- Bộ preset dựng sẵn: Termius Dark/Light, Flexoki Dark/Light, Kanagawa (Wave/Dragon/Lotus),
  Hacker (Blue/Green/Red), Everforest Dark/Light…
- Preview thu nhỏ từng theme; click để chọn
- Cho phép **theme tùy chỉnh** (16 màu ANSI + fg/bg/cursor/selection) — có thể để sau MVP

**SFTP**
- Thư mục local mặc định, hiện file ẩn, hành vi ghi đè khi trùng tên

**Shortcuts**
- Xem/sửa phím tắt (new tab, split, tìm kiếm, copy/paste…)

### Cơ chế áp dụng
- Theme app đổi CSS variables ở root → toàn UI đổi ngay, không cần reload.
- Terminal theme map sang `ITheme` của xterm.js, áp cho mọi terminal đang mở.
- Mỗi thay đổi ghi vào SQLite + đánh dấu vault "dirty" → auto-sync (debounce).

---

## 3e. Password manager (vault riêng, kiểu KeePassXC)

Không dùng định dạng `.kdbx`. Tái sử dụng **đúng vault E2E đã có** (mục 3b): password entry nằm
chung trong `vault.enc`, cùng master password, cùng cơ chế sync GitHub. Một khóa, một nơi, đồng bộ sẵn.

### Data model
```
Group (cây, lồng nhau)         Entry
 ├─ id, name, parent_id         ├─ id, group_id, title
 └─ icon                        ├─ username, password (secret)
                                ├─ url, notes, tags[]
                                ├─ totp_secret (secret, tùy chọn)
                                ├─ custom_fields[] (key/value, có thể đánh dấu secret)
                                ├─ created_at, updated_at, expires_at?
                                └─ linked_host_id?  ← liên kết tới SSH host
```
- Toàn bộ entry + field secret **chỉ tồn tại ở dạng giải mã trong RAM** khi vault đã mở khóa;
  khi lưu/sync thì nằm trong `vault.enc` (ciphertext).

### Tính năng
- **Group/entry/search**: cây group ở sidebar, bảng entry (Title/Username/URL/Notes), tìm kiếm nhanh + lọc theo tag; copy username/password 1 click (tự xóa clipboard sau N giây).
- **Password generator + độ mạnh**: sinh mật khẩu tùy chỉnh (độ dài, chữ/số/ký hiệu, tránh ký tự dễ nhầm); đo độ mạnh (`zxcvbn`); màn "Weak/Expired passwords" như KeePassXC.
- **TOTP / 2FA**: lưu `totp_secret`, sinh mã 6 số xoay vòng 30s kèm vòng đếm ngược, copy 1 click.
- **Liên kết entry ↔ SSH host** (điểm riêng): host có thể trỏ tới 1 entry làm credential → sửa mật khẩu ở một chỗ, mọi host dùng entry đó đều cập nhật; ngược lại từ entry mở nhanh phiên SSH.

### Bảo mật
- Copy clipboard tự hết hạn; ẩn/hiện password có kiểm soát.
- Master password khóa cả app: đóng/timeout → khóa lại, phải nhập master mới xem secret.
- Không ghi secret ra log, không đưa vào URL/telemetry.

---

## 4. Cấu trúc thư mục dự kiến

```
terminus/
├── src/                      # Frontend React
│   ├── components/           # HostList, Terminal, SftpBrowser, KeyManager, Vault, Settings…
│   ├── themes/               # preset terminal themes + theme app (CSS vars)
│   ├── store/                # state (zustand)
│   └── lib/ipc.ts            # wrapper gọi Tauri commands
├── src-tauri/
│   ├── src/
│   │   ├── ssh/              # client, pty, sftp, tunnel, jump
│   │   ├── db/               # models + migrations (sqlx)
│   │   ├── keys/             # keygen, keychain
│   │   ├── sync/             # crypto (argon2+xchacha) + github client
│   │   ├── vault/            # password manager: group/entry model, generator, totp
│   │   └── commands.rs       # các #[tauri::command]
│   └── tauri.conf.json
└── package.json
```

---

## 5. Lộ trình theo giai đoạn

### Phase 0 — Prerequisites & scaffold ✅
- [x] Cài Rust 1.98 (rustup) + Tauri CLI (qua pnpm 2.11.4)
- [x] Cài webkit2gtk-4.1 + build deps (đã sửa lỗi thiếu pocket `jammy-updates`)
- [x] Scaffold Tauri v2 + React-TS + pnpm (identifier `com.terminus.app`), frontend build OK
- [x] Backend Rust compile OK (315 crates, ~2 phút), `pnpm tauri dev` chạy được

### Phase 1 — SSH terminal + quản lý host (lõi) ✅
- [x] Schema SQLite: `groups`, `hosts` (sqlx, auto-migrate lúc khởi động)
- [x] CRUD host + UI danh sách theo nhóm (sidebar) + form thêm/sửa
- [x] Quản lý nhóm kiểu Termius: tạo nhóm trong form host + ở sidebar, nhóm thu gọn/mở, đếm host, xóa nhóm
- [x] Kết nối SSH bằng russh (backend `ring`) + PTY + shell, render qua xterm.js
- [x] Resize terminal (FitAddon → window_change), nhiều tab/phiên song song
- [x] **Split view kiểu Termius (dockview): kéo tab thả vào cạnh → tự chia lưới, resize pane, giữ phiên khi kéo**
- [x] **Broadcast (gõ 1 lần ra mọi pane, có viền đỏ cảnh báo) + nút Split nhanh (mở thêm shell server active sang phải)**
- [ ] TODO Phase 2/5: auth bằng key, mã hóa secret (hiện password lưu tạm plaintext trong SQLite)
- [ ] TODO Phase sau: known_hosts verification (hiện chấp nhận mọi server key)

### Phase 2 — SSH key management ✅
- [x] Tạo key (ed25519/rsa qua ssh-keygen), import key có sẵn (validate bằng russh)
- [x] Lưu secret qua OS keychain (secret-service): private key, passphrase, mật khẩu host — KHÔNG còn plaintext trong SQLite
- [x] Gán key ↔ host (managed key `key_id` hoặc đường dẫn file), auth bằng public key
- [x] UI KeyManager (list/tạo/import/xóa) + chọn key trong form host
- [x] Migration DB Phase 1 (thêm cột `key_id`, bảng `ssh_keys`) chạy tự động
- [ ] TODO: known_hosts verification (vẫn chấp nhận mọi server key — để phase sau)

### Header search + i18n + copy/paste ✅
- [x] Ô tìm nhanh host trên header (tên/IP/user), Enter/click để mở SSH ngay (HostSearch)
- [x] Chuyển **toàn bộ UI sang tiếng Anh** (84 chuỗi, 10 file)
- [x] Copy/paste terminal kiểu Linux: **Ctrl+Shift+C** (copy vùng chọn) / **Ctrl+Shift+V** (paste), tôn trọng broadcast

### Đổi tên → Termez + Home dashboard ✅
- [x] Đổi tên app **Terminus → Termez** (productName, identifier `com.termez.app`, crate, window title, brand); chép DB cũ sang giữ nguyên host/key; keychain service giữ nguyên để không mất secret
- [x] Đặt lại font mặc định **Inter** + antialiasing (bị mất khi migrate Tailwind)
- [x] **HomeView**: khi chưa mở host nào, hiện trang chủ Groups + Hosts dạng card (như Termius), click host để mở, click group để lọc

### Redesign UI — Tailwind + shadcn/ui ✅
- [x] Áp design system từ skill **ui-ux-pro-max**: Dark Mode (OLED), palette slate + accent run-green `#22c55e`
- [x] Chuyển toàn bộ frontend sang **Tailwind v4 + shadcn/ui**; token ở `src/index.css`
- [x] Thay **emoji → SVG lucide** (đúng checklist skill); focus ring, hover 150ms
- [x] Modal → shadcn Dialog; select → shadcn Select; Button/Input/Checkbox/Textarea shadcn
- [x] Xóa `App.css`; alias `@`→`src`

### Host advanced options (bổ sung, kiểu Termius Host Details) ✅
- [x] Ô chọn endpoint SFTP có tìm kiếm (combobox lọc theo label/địa chỉ/user)
- [x] Startup snippet — lệnh tự chạy khi vừa kết nối
- [x] Keep-alive — giữ kết nối (russh keepalive_interval)
- [x] Terminal theme + cỡ chữ riêng cho từng host (preset: Navy/Dark/Solarized/Hacker/Light)
- [x] Proxy SOCKS5 & HTTP CONNECT (mật khẩu proxy lưu keychain), áp cho cả terminal & SFTP
- [ ] Cân nhắc sau: Agent forwarding, Mosh, Certificate/FIDO2, per-host environment vars

### Phase 3 — SFTP file browser (dual-pane, đa endpoint) ✅
- [x] Giao diện 2 pane (là dockview panel — chia/kéo cạnh terminal được), mỗi pane chọn endpoint (Local hoặc server đã lưu)
- [x] Duyệt thư mục, mkdir, xóa trên cả 2 pane (dùng chung resolve_auth + keychain)
- [x] Chuyển file **Local ↔ Server** (upload/download) qua nút →/←
- [x] Chuyển file **Server ↔ Server** (relay-streaming qua local theo chunk 64KB)
- [x] Transfer queue + thanh tiến trình % theo event
- [x] **Kéo-thả file giữa 2 pane để chuyển (highlight vùng thả)**
- [ ] TODO: chuyển cả thư mục (đệ quy); đổi tên; hủy transfer đang chạy; chọn nhiều file

### Phase 4 — Port forwarding & jump host ✅
- [x] **Jump host (ProxyJump)** nhiều tầng: host chọn `jump_host_id`, conn.rs kết nối qua chuỗi jump (direct-tcpip), áp cho cả terminal & SFTP
- [x] Port forwarding **Local (-L)** + **Dynamic/SOCKS5 (-D)** qua direct-tcpip
- [x] Tunnel lưu DB (`tunnels`), TunnelManager start/stop, giữ kết nối sống
- [x] UI: panel "Port Forwarding" (list + toggle Start/Stop + trạng thái), form tạo/sửa tunnel; chọn jump host trong form host
- [ ] TODO: Remote forward (-R) (cần callback nhận kênh forwarded-tcpip từ server)

### Phase 5 — Đồng bộ cloud qua GitHub ✅
- [x] Crypto: Argon2id + XChaCha20-Poly1305 (encrypt/decrypt vault, có test roundtrip)
- [x] Vault gom DB (hosts/groups/keys/tunnels) + secret keychain → JSON → mã hóa E2E bằng master password
- [x] GitHub client (reqwest rustls/ring): PAT lưu keychain, đọc/ghi `vault.enc` qua Contents API (dùng sha để update)
- [x] UI SyncDialog: repo + PAT + master password, nút Backup (push) / Restore (pull), khôi phục ghi lại DB + keychain rồi refresh
- [x] **Auto-sync im lặng**: toggle bật → lưu master vào keychain, mọi thay đổi (host/key/tunnel/group) tự backup sau debounce 3s, phát event `sync:auto`
- [ ] TODO: pull-before-push cảnh báo xung đột, recovery code, tự tạo repo

### Phase 6 — Password manager (vault riêng)
- [ ] Model group/entry trong vault đã mã hóa (dùng lại crypto Phase 5)
- [ ] UI cây group + bảng entry (Title/Username/URL/Notes/tags), thêm/sửa/xóa
- [ ] Search + lọc tag; copy username/password (auto-clear clipboard)
- [ ] Password generator + đo độ mạnh (`zxcvbn`) + màn Weak/Expired
- [ ] TOTP: lưu secret, sinh mã 6 số + đếm ngược, copy 1 click
- [ ] Liên kết entry ↔ SSH host (dùng entry làm credential kết nối)
- [ ] Auto-lock khi timeout/đóng app

### Phase 7 — Settings, giao diện & hoàn thiện
- [ ] Cửa sổ Settings dạng sidebar; lưu key-value vào SQLite + đưa vào vault sync
- [ ] Appearance: theme app Auto/Light/Dark (CSS variables, đổi tức thì)
- [ ] Terminal: font, text size, emulation type, các toggle hành vi (autoreconnect, bell, copy-on-select…)
- [ ] Terminal theme: bộ preset (Termius/Flexoki/Kanagawa/Hacker/Everforest…) + preview, áp qua xterm `ITheme`
- [ ] Shortcuts: xem/sửa phím tắt; SFTP settings
- [ ] Snippets (lệnh nhanh), search
- [ ] Đóng gói `.deb` / AppImage

---

## 6. Rủi ro cần lưu ý
- **PTY streaming & resize**: phần khó nhất — cần xử lý backpressure và đồng bộ kích thước terminal.
- **Bảo mật secret**: làm đúng từ đầu (keychain/mã hóa), tránh nợ kỹ thuật.
- **Host key verification**: không được bỏ qua.
- **Quên master password = mất vault** (zero-knowledge): cần cảnh báo rõ + recovery code tùy chọn.
- **Xung đột khi dùng đa máy**: blob đơn dễ bị last-write-wins ghi đè — bắt buộc pull-before-push.
- **Không commit plaintext / PAT lên repo**: chỉ `vault.enc` lên GitHub; PAT & key giải mã ở keychain.
- **Relay server→server tốn băng thông local** & dễ đứt nếu mạng yếu: cần streaming theo chunk + retry, và để ngỏ đường nâng cấp direct A→B.

---

## 7. Các crate/thư viện dự kiến

| Mục đích | Crate (Rust) / Package (JS) |
|----------|------------------------------|
| SSH client | `russh`, `russh-keys` |
| SFTP | `russh-sftp` |
| PTY | `portable-pty` |
| DB | `sqlx` (SQLite) |
| SSH keygen/parse | `ssh-key` |
| Keychain | `keyring` |
| Mã hóa vault | `argon2`, `chacha20poly1305`, `rand`, `base64` |
| Password manager | `zxcvbn` (độ mạnh), `totp-rs` (TOTP/2FA) |
| GitHub API / HTTP | `reqwest`, `serde_json` |
| Async runtime | `tokio` |
| Terminal UI | `@xterm/xterm` + `@xterm/addon-fit` |
| State | `zustand` |
| UI | `tailwindcss` + `shadcn/ui` |

---

_Trạng thái: Kế hoạch đã chốt. Chưa bắt đầu code. Bước kế tiếp: Phase 0._
