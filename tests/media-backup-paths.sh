#!/usr/bin/env bash
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
shared="$work/shared"
mkdir -p "$shared/uploads" "$shared/archives/tree-b/uploads"
printf legacy > "$shared/uploads/one.jpg"
printf private > "$shared/archives/tree-b/uploads/two.pdf"
printf temporary > "$shared/archives/tree-b/uploads/.pending.upload"
printf database > "$shared/archives/tree-b/drevo.sqlite"
paths="$(bash "$repo/ops/postgres/media-backup-paths.sh" "$shared")"
[[ "$paths" == $'uploads\narchives/tree-b/uploads' ]]
mapfile -t source_paths <<< "$paths"
tar --exclude='uploads/.*' --exclude='archives/*/uploads/.*' \
  -C "$shared" -czf "$work/media.tar.gz" -- "${source_paths[@]}"
tar -tzf "$work/media.tar.gz" > "$work/files"
grep -qx 'uploads/one.jpg' "$work/files"
grep -qx 'archives/tree-b/uploads/two.pdf' "$work/files"
! grep -q 'drevo.sqlite' "$work/files"
! grep -q '.pending.upload' "$work/files"
ln -s "$shared/archives/tree-b" "$shared/archives/evil"
if [[ -L "$shared/archives/evil" ]] &&
  bash "$repo/ops/postgres/media-backup-paths.sh" "$shared" > /dev/null 2>&1; then
  echo 'Symlinked archive directory was accepted' >&2
  exit 1
fi
