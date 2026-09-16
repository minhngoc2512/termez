# Packaging Termez for `apt`

Tauri already emits a Debian package. To let users install and **auto-update**
via `apt`, publish those `.deb` files through a signed apt repository. The
easiest zero-cost host is GitHub Pages on this repo.

## 1. One-time setup

```bash
sudo apt install dpkg-dev apt-utils gnupg
pnpm install
```

Create a signing key once (used to sign every release so apt trusts it):

```bash
gpg --full-generate-key          # pick RSA 4096, no expiry is fine for a start
gpg --list-secret-keys --keyid-format=long   # note the key id / email
```

Keep this key private. Only its **public** half is shipped to users.

## 2. Build the `.deb` and the repo

```bash
GPG_KEY_ID=you@example.com scripts/build-apt-repo.sh
```

This builds `Termez_<version>_amd64.deb` and assembles a signed *flat* apt repo
in `./apt-repo/` (Packages index, Release/InRelease, and the public keyring).

The version comes from `src-tauri/tauri.conf.json` (`version`) — bump it there
(and in `package.json`) for each release so `apt upgrade` sees the new build.

## 3. Publish to GitHub Pages

One command pushes `apt-repo/` to the `gh-pages` branch (served at
`https://minhngoc2512.github.io/termez/apt`) without touching your main tree:

```bash
scripts/publish-apt.sh
```

It creates the orphan `gh-pages` on first run, updates it in place afterwards
(old package versions stay available), and enables GitHub Pages via `gh` when
possible. Override with `BRANCH=…` / `SUBDIR=…` if you host differently.

If you'd rather do it by hand: put `apt-repo/*` under `apt/` on a `gh-pages`
branch, add a `.nojekyll`, push, and enable Pages (Settings → Pages → branch
`gh-pages`, folder `/`).

## 4. How users install

```bash
curl -fsSL https://minhngoc2512.github.io/termez/apt/termez-archive-keyring.gpg \
  | sudo tee /usr/share/keyrings/termez.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/termez.gpg] https://minhngoc2512.github.io/termez/apt ./" \
  | sudo tee /etc/apt/sources.list.d/termez.list
sudo apt update && sudo apt install termez
```

Updates arrive with a normal `sudo apt update && sudo apt upgrade`.

## Notes

- The in-app **Check for updates** (Settings → About) reads GitHub Releases, so
  also attach the `.deb` to a GitHub Release tagged `v<version>` for users who
  prefer a manual download.
- `dpkg -i Termez_<version>_amd64.deb` still works for a one-off install without
  the repo, but won't auto-update.
- CI option: run `scripts/build-apt-repo.sh` in a GitHub Actions job (Ubuntu
  runner, GPG key in a secret) and deploy `apt-repo/` with `actions/deploy-pages`.
