#!/usr/bin/env bash
#
# Publish the signed apt INDEX built by scripts/build-apt-repo.sh (Packages,
# Release, InRelease, keyring — small files) to the `gh-pages` branch, then trigger
# the Pages workflow, which serves it at https://<user>.github.io/<repo>/apt
# together with the .deb fetched from the GitHub Release (SHA256-checked).
#
# The .deb is NOT committed: GitHub rejects files > 100 MB and each release would
# bloat the branch by ~100 MB. The branch is updated through a throwaway worktree.
#
# Usage:
#   scripts/build-apt-repo.sh   # produces ./apt-repo (run this first)
#   scripts/publish-apt.sh
#
# Optional: BRANCH (default gh-pages), SUBDIR (default apt).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apt-repo"
BRANCH="${BRANCH:-gh-pages}"
SUBDIR="${SUBDIR:-apt}"
WT="$(mktemp -d)"

cleanup() { git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"; }
trap cleanup EXIT

# Sanity: the repo must be built and signed.
for f in InRelease Release Packages; do
  [[ -f "$SRC/$f" ]] || { echo "!! $SRC/$f missing — run scripts/build-apt-repo.sh first." >&2; exit 1; }
done

cd "$ROOT"
git fetch origin "$BRANCH" 2>/dev/null || true

if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "==> Updating existing $BRANCH"
  git worktree add --force "$WT" "origin/$BRANCH" >/dev/null 2>&1
  git -C "$WT" checkout -B "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1
else
  echo "==> Creating orphan $BRANCH"
  git worktree add --detach "$WT" >/dev/null 2>&1
  git -C "$WT" checkout --orphan "$BRANCH" >/dev/null 2>&1
  git -C "$WT" rm -rf . >/dev/null 2>&1 || true
fi

# Replace the repo contents (fresh index for the subdir) and keep Pages happy.
rm -rf "${WT:?}/$SUBDIR"
mkdir -p "$WT/$SUBDIR"
find "$SRC" -maxdepth 1 -type f ! -name '*.deb' -exec cp {} "$WT/$SUBDIR/" \;
touch "$WT/.nojekyll"

cd "$WT"
git add -A
VER="$(grep -m1 '^Version:' "$SRC/Packages" | awk '{print $2}')"
if git diff --cached --quiet; then
  echo "==> Index unchanged on $BRANCH."
else
  git commit -q -m "Publish apt index (${VER:-update})"
  git push origin "$BRANCH"
fi

# Deploy: the Pages workflow builds the website, adds this index and pulls the
# .deb from the GitHub Release (verifying its SHA256 against Packages).
SLUG="$(git -C "$ROOT" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
gh workflow run pages.yml -R "$SLUG" --ref main
echo "==> Deploy started (workflow pages.yml). Live in ~2 min at: https://$(echo "$SLUG" | sed 's#/#.github.io/#')/$SUBDIR"
