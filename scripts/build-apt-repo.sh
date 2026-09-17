#!/usr/bin/env bash
#
# Build the Termez .deb and assemble a *signed flat apt repository* that can be
# served over plain HTTP(S) — e.g. GitHub Pages. Users then install with `apt`
# and receive future versions through `apt upgrade`.
#
# Prerequisites (Ubuntu/Debian):
#   sudo apt install dpkg-dev apt-utils gnupg
#   pnpm install
#   # a GPG signing key — create one once with:  gpg --full-generate-key
#
# Usage:
#   GPG_KEY_ID=you@example.com scripts/build-apt-repo.sh
#
# Output: ./apt-repo/  (publish its contents to your web root / GitHub Pages)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apt-repo"
# Public base URL where the repo will be served (used only in the printed hint).
PAGES_URL="${PAGES_URL:-https://minhngoc2512.github.io/termez/apt}"

if [[ -z "${GPG_KEY_ID:-}" ]]; then
  echo "!! Set GPG_KEY_ID to the signing key (email or fingerprint)." >&2
  echo "   List keys with:  gpg --list-secret-keys --keyid-format=long" >&2
  exit 1
fi

# Nhập passphrase MỘT LẦN ở đầu (trước khi build ~vài phút) rồi ký bằng loopback
# pinentry — tránh việc pinentry hết giờ chờ sau khi build xong.
# Bỏ trống (Enter) nếu key không có passphrase, hoặc muốn để gpg-agent tự xử lý.
GPG_SIGN=(gpg --default-key "$GPG_KEY_ID" --batch --yes)
if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
  GPG_SIGN=(gpg --default-key "$GPG_KEY_ID" --batch --yes --pinentry-mode loopback --passphrase "$GPG_PASSPHRASE")
elif [[ -t 0 ]]; then
  read -rsp "GPG passphrase for $GPG_KEY_ID (Enter to skip → dùng agent): " _pp; echo
  if [[ -n "$_pp" ]]; then
    GPG_SIGN=(gpg --default-key "$GPG_KEY_ID" --batch --yes --pinentry-mode loopback --passphrase "$_pp")
    # Kiểm tra passphrase đúng ngay để khỏi build xong mới biết sai.
    if ! printf 'x' | "${GPG_SIGN[@]}" -o /dev/null -abs 2>/dev/null; then
      echo "!! Passphrase sai (hoặc ký thử thất bại)." >&2
      exit 1
    fi
  fi
  unset _pp
fi

echo "==> Building release bundle (.deb)…"
cd "$ROOT"
pnpm tauri build --bundles deb

DEB="$(ls -t "$ROOT"/src-tauri/target/release/bundle/deb/*.deb | head -n1)"
[[ -f "$DEB" ]] || { echo "!! No .deb produced." >&2; exit 1; }
echo "==> Built: $DEB"

echo "==> Assembling flat apt repo in $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$DEB" "$OUT/"

cd "$OUT"
# Package index (flat repo: everything at the root, suite = ./).
dpkg-scanpackages --multiversion . > Packages
gzip -9c Packages > Packages.gz

# Release file with checksums.
apt-ftparchive \
  -o "APT::FTPArchive::Release::Origin=Termez" \
  -o "APT::FTPArchive::Release::Label=Termez" \
  -o "APT::FTPArchive::Release::Suite=stable" \
  -o "APT::FTPArchive::Release::Codename=stable" \
  -o "APT::FTPArchive::Release::Architectures=amd64" \
  -o "APT::FTPArchive::Release::Components=main" \
  release . > Release

# Sign it (both detached and inline, so old and new apt clients both work).
"${GPG_SIGN[@]}" -abs -o Release.gpg Release
"${GPG_SIGN[@]}" --clearsign -o InRelease Release

# Export the public key users must trust.
gpg --export "$GPG_KEY_ID" > termez-archive-keyring.gpg

echo
echo "==> Done. Publish the contents of $OUT to: $PAGES_URL"
echo
echo "    Users install with:"
echo "      curl -fsSL $PAGES_URL/termez-archive-keyring.gpg | sudo tee /usr/share/keyrings/termez.gpg >/dev/null"
echo "      echo \"deb [signed-by=/usr/share/keyrings/termez.gpg] $PAGES_URL ./\" | sudo tee /etc/apt/sources.list.d/termez.list"
echo "      sudo apt update && sudo apt install termez"
