#!/usr/bin/env bash
#
# Dựng thư mục site cho GitHub Pages: website + apt repo.
#
#   scripts/assemble-pages.sh <web-dist> <apt-index-dir> <out-dir>
#
# - Chép website (<web-dist>) vào <out-dir>.
# - Chép chỉ mục apt đã ký (<apt-index-dir>, bỏ qua mọi *.deb) vào <out-dir>/apt.
# - Với mỗi gói trong Packages: tải .deb từ GitHub Release v<Version> (deb dùng
#   "~" cho pre-release → tag dùng "-") và kiểm SHA256 khớp chỉ mục; lệch là lỗi.
# Cần `gh` đã đăng nhập (trên CI: GH_TOKEN). Dùng được cả trên máy để thử.
set -euo pipefail

WEB="${1:?web dist}"
IDX="${2:?apt index dir}"
OUT="${3:?out dir}"
REPO="${GITHUB_REPOSITORY:-$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"

rm -rf "$OUT"
mkdir -p "$OUT/apt"
cp -r "$WEB/." "$OUT/"
touch "$OUT/.nojekyll"
find "$IDX" -maxdepth 1 -type f ! -name '*.deb' -exec cp {} "$OUT/apt/" \;
[[ -f "$OUT/apt/Packages" ]] || { echo "!! Không có $IDX/Packages" >&2; exit 1; }

# Mỗi đoạn (stanza) của Packages → "tên-file version sha256".
LIST="$(mktemp)"
awk -v RS= '{
  f = v = h = ""
  n = split($0, L, "\n")
  for (i = 1; i <= n; i++) {
    if (L[i] ~ /^Filename:/) { f = L[i]; sub(/^Filename:[ \t]*(\.\/)?/, "", f) }
    if (L[i] ~ /^Version:/)  { v = L[i]; sub(/^Version:[ \t]*/, "", v) }
    if (L[i] ~ /^SHA256:/)   { h = L[i]; sub(/^SHA256:[ \t]*/, "", h) }
  }
  if (f != "") print f, v, h
}' "$OUT/apt/Packages" > "$LIST"
[[ -s "$LIST" ]] || { echo "!! Packages không có gói nào" >&2; exit 1; }

while read -r file ver sha; do
  tag="v${ver//\~/-}"
  echo "→ $file  (release $tag)"
  gh release download "$tag" -R "$REPO" -p "$file" -D "$OUT/apt"
  echo "$sha  $OUT/apt/$file" | sha256sum -c -
done < "$LIST"
rm -f "$LIST"

echo "==> Site: $(du -sh "$OUT" | cut -f1) trong $OUT"
