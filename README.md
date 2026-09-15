# ⌘ Termez

A fast, native-feeling **SSH / SFTP manager** for Linux — a Termius-style desktop client built with **Tauri (Rust)** + **React**. Manage a fleet of servers, split terminals, browse and move files, tunnel ports, and back everything up to your own GitHub repo with end-to-end encryption.

> **Term** (terminal) + **Ez** (easy).

---

## Features

**Terminals**
- SSH terminal with real PTY (via [`russh`](https://crates.io/crates/russh), `ring` backend)
- **Split view** (dockview): drag a tab onto any edge to tile panes; drag to reorder/merge
- **Broadcast**: type once, send to every open pane
- Per-host **terminal theme & font size**, `Ctrl+Shift+C` / `Ctrl+Shift+V` copy-paste
- Hover a tab to see the host IP with a one-click copy button

**Host management**
- Hosts organized into **collapsible groups** with counts
- Home dashboard of Groups + Hosts cards; quick **search** by name / IP in the header
- Password or **SSH key** auth (generate ed25519/rsa, or import an existing key)
- Advanced per host: startup snippet, keep-alive, proxy (**SOCKS5 / HTTP CONNECT**), and **jump host (ProxyJump, multi-hop)**

**SFTP**
- Dual-pane file browser; **each pane picks any endpoint** (Local or any server)
- Transfer **Local ↔ Server** and **Server ↔ Server** (relayed), with a progress queue
- **Drag & drop** files between panes; mkdir / delete

**Port forwarding**
- **Local (-L)** and **Dynamic / SOCKS5 (-D)** tunnels, start/stop with live status

**Cloud sync (optional)**
- Back up hosts, keys, tunnels **and secrets** to a **private GitHub repo**
- **End-to-end encrypted** (Argon2id + XChaCha20-Poly1305) with a master password — GitHub only ever stores ciphertext
- Manual **Backup / Restore**, or **silent auto-sync** on every change

**Security**
- Secrets (passwords, private keys, passphrases, proxy/GitHub tokens) live in the **OS keychain** (Secret Service), never in plaintext in the database
- Zero-knowledge cloud vault: forget the master password → the backup cannot be recovered

---

## Tech stack

| Layer | Tech |
|-------|------|
| Shell | Tauri 2 (Rust), custom titlebar |
| SSH / SFTP | `russh` (ring), `russh-sftp` |
| Crypto | `argon2`, `chacha20poly1305` |
| Proxy / tunnels | `tokio-socks`, `async-http-proxy`, direct-tcpip channels |
| Storage | SQLite (`sqlx`), OS keychain (`keyring`) |
| Cloud | GitHub Contents API (`reqwest`, rustls) |
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

Bundles are produced under `src-tauri/target/release/bundle/`:
- `.deb` → `bundle/deb/`
- `.AppImage` → `bundle/appimage/`

---

## Notes

- The keychain namespace is a stable internal string kept across renames so stored secrets are never orphaned.
- VPN (OpenVPN) is intentionally **out of scope** — it requires root and changes system-wide routing; use a **jump host** or a **SOCKS tunnel** to reach private servers from userspace instead.

---

Built with [Claude Code](https://claude.com/claude-code).
