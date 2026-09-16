#!/usr/bin/env bash
#
# Publish the signed apt repository built by scripts/build-apt-repo.sh to the
# `gh-pages` branch, served by GitHub Pages at:
#   https://<user>.github.io/<repo>/apt
#
# It never touches your main working tree: the branch is updated through a
# throwaway git worktree. First run creates an orphan `gh-pages`; later runs
# update it in place (so old package versions stay available for `apt`).
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
cp "$SRC"/* "$WT/$SUBDIR/"
touch "$WT/.nojekyll"

cd "$WT"
git add -A
if git diff --cached --quiet; then
  echo "==> No changes to publish."
  exit 0
fi

VER="$(grep -m1 '^Version:' "$SRC/Packages" | awk '{print $2}')"
git commit -q -m "Publish apt repo (${VER:-update})"
git push origin "$BRANCH"

# Best-effort: make sure Pages is enabled for this branch/path.
if command -v gh >/dev/null 2>&1; then
  SLUG="$(git -C "$ROOT" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
  gh api "repos/$SLUG/pages" >/dev/null 2>&1 || \
    gh api -X POST "repos/$SLUG/pages" -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 || true
  echo "==> Published. Live shortly at: https://$(echo "$SLUG" | sed 's#/#.github.io/#')/$SUBDIR"
else
  echo "==> Pushed $BRANCH. Enable GitHub Pages (branch $BRANCH, / root) if not already."
fi
