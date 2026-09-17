# ⌘ Termez

A fast, native-feeling **SSH / SFTP manager** for Linux, macOS and Windows — a Termius-style desktop
client built with **Tauri (Rust)** + **React**. Manage a fleet of servers, split
terminals, browse and move files, keep passwords and cloud storage, watch hosts
live, and back everything up to your own GitHub repo with end-to-end encryption.

> **Term** (terminal) + **Ez** (easy).

**[🌐 Website](https://minhngoc2512.github.io/termez/)** · **[⬇ Download](https://github.com/minhngoc2512/termez/releases/latest)** · **[📦 apt repo](https://minhngoc2512.github.io/termez/apt)**

---

## Download & install

Prebuilt installers for **Linux, macOS and Windows** are attached to every
[release](https://github.com/minhngoc2512/termez/releases/latest).

### Linux — via apt (recommended)

```bash
curl -fsSL https://minhngoc2512.github.io/termez/apt/termez-archive-keyring.gpg | sudo tee /usr/share/keyrings/termez.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/termez.gpg] https://minhngoc2512.github.io/termez/apt ./" | sudo tee /etc/apt/sources.list.d/termez.list
sudo apt update && sudo apt install termez
```

### Update

Update **only Termez** (leaves the rest of the system untouched):

```bash
sudo apt update && sudo apt install --only-upgrade termez
```

Handy checks:

```bash
apt policy termez                              # installed vs available version
apt list --upgradable 2>/dev/null | grep termez   # is a new version out?
```

`sudo apt upgrade` also updates Termez, but upgrades every other package too —
use the `--only-upgrade` command above if you just want the app. Settings →
About → **Check for updates** tells you when a new version is available.

### One-off `.deb`

Download the latest `Termez_*_amd64.deb` from
[**Releases**](https://github.com/minhngoc2512/termez/releases/latest), then:

```bash
sudo apt install ./Termez_*_amd64.deb
```

### Linux — portable `.AppImage`

Download `Termez_*_amd64.AppImage`, then:

```bash
chmod +x Termez_*_amd64.AppImage && ./Termez_*_amd64.AppImage
```

### macOS

Download **`Termez_*_universal.dmg`** (one build for both Apple Silicon and
Intel), open it and drag Termez to Applications.

> The app is **not notarized**, so the first launch is blocked by Gatekeeper.
> Right-click the app → **Open** → **Open**, or run once:
> `xattr -dr com.apple.quarantine /Applications/Termez.app`

### Windows

Download **`Termez_*_x64_en-US.msi`** (or `Termez_*_x64-setup.exe`) and run it.

> The installer is **unsigned**, so SmartScreen may warn: click **More info →
> Run anyway**. Requires the WebView2 runtime (preinstalled on Windows 11).

An `.rpm` is also attached to each release. Maintainer packaging steps live in
[PACKAGING.md](PACKAGING.md).

---

## Features

**Terminals**
- SSH terminal with a real PTY (via [`russh`](https://crates.io/crates/russh), `ring` backend)
- **Split view** (dockview): drag a tab to any edge to tile panes; drag to reorder/merge
- **Broadcast**: type once, send to every open pane
- Per-host **terminal theme & font size**; hover a tab to copy the host IP

**Host management**
- Hosts in **collapsible groups**; home dashboard + header **search** by name / IP
- Password or **SSH key** auth (generate ed25519 / rsa, or import a key)
- Per host: startup snippet, keep-alive, **SOCKS5 / HTTP CONNECT** proxy, and
  **jump host (ProxyJump, multi-hop)**
- **ProxyCommand** support + **`~/.ssh/config` import** — reach hosts behind
  Cloudflare Tunnel and other stdio proxies
- **Host key verification** (TOFU) with a **Known Hosts** view

**Passwords** (KeePassXC-style vault)
- Folder tree + entry table + detail pane; nested folders
- Import KeePass **`.kdbx`** files (folder structure preserved)
- Masked password field with reveal; `Ctrl+C` copy password / `Ctrl+U` copy URL
  with a **10-second auto-clearing clipboard** countdown

**SFTP**
- Dual-pane browser; **each pane picks any endpoint** (Local or any server)
- Transfer **Local ↔ Server** and **Server ↔ Server**, with a progress queue
- **Drag & drop** between panes; mkdir / delete

**Storage** (S3 / R2 / GCS / MinIO)
- Browse buckets, **upload / download / delete**, copy public URL
- Copy / cut / paste, new folder, multi-select, right-click menu
- **Drag-drop upload** with progress, speed and conflict resolution
- **Bucket-to-bucket transfer** in an SFTP-style dual pane (any provider to any)

**Port forwarding**
- **Local (-L)** and **Dynamic / SOCKS5 (-D)** tunnels, start/stop with live status

**Monitoring**
- Open a **per-host Monitor tab**: live CPU / RAM / disk / network charts

**Network scan**
- **LAN device discovery** (IP / MAC / vendor / hostname), host discovery and
  **port scan**, with a filter box — add a discovered host in one click

**Cloudflare DNS**
- Manage DNS records through the Cloudflare API (credentials stay local, never synced)

**Cloud sync** (optional)
- Back up hosts, keys, tunnels, **passwords and storage connections** to a
  **private GitHub repo**
- **End-to-end encrypted** (Argon2id + XChaCha20-Poly1305) with a master password
  — GitHub only ever stores ciphertext
- **Auto-pull** on startup and periodically, with **conflict resolution**

**Security & app lock**
- Secrets live in the **OS keychain** (Secret Service), never plaintext in the DB
- **App Lock**: master password to open the app + **idle auto-lock**
- **Two-factor (TOTP)** with a configurable **re-authentication interval**

**Settings & updates**
- App theme **light / dark / system**, terminal theme & font size
- **About** panel with version and a **GitHub-release update check**

---

## Tech stack

| Layer | Tech |
|-------|------|
| Shell | Tauri 2 (Rust), custom titlebar |
| SSH / SFTP | `russh` (ring), `russh-sftp` |
| Crypto | `argon2`, `chacha20poly1305`, `totp-rs` (2FA) |
| Proxy / tunnels | `tokio-socks`, `async-http-proxy`, ProxyCommand, direct-tcpip |
| Storage / cloud | S3 SigV4 (`reqwest`, `hmac`, `sha2`), GitHub Contents API |
| Local storage | SQLite (`sqlx`), OS keychain (`keyring`) |
| Frontend | React 19, TypeScript, Vite, Tailwind v4, shadcn/ui, lucide, xterm.js, dockview |

---

## Development

### Prerequisites
- **Rust** (stable) via [rustup](https://rustup.rs)
- **Node 18+** and **pnpm**
- Linux system libraries for Tauri:

```bash
sudo apt install -y libwebkit2gtk-4.1-dev librsvg2-dev libgtk-3-dev \
  libxdo-dev libayatana-appindicator3-dev build-essential pkg-config
```

### Run

```bash
pnpm install
pnpm tauri dev
```

### Build installers

```bash
pnpm tauri build
```

Bundles land under `src-tauri/target/release/bundle/` (`deb/`, `appimage/`, `rpm/`).

---

## Notes

- The keychain namespace is a stable internal string kept across renames so stored
  secrets are never orphaned.
- On some Linux GPUs/drivers WebKitGTK's DMABUF renderer shows a black window; the
  app disables it at startup (`WEBKIT_DISABLE_DMABUF_RENDERER`) so it renders everywhere.
- VPN (OpenVPN) is intentionally **out of scope** — it needs root and changes
  system-wide routing; use a **jump host** or a **SOCKS tunnel** instead.

---

Built with [Claude Code](https://claude.com/claude-code).
