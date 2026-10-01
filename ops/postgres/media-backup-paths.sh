#!/usr/bin/env bash
set -euo pipefail

shared="${1:?Usage: media-backup-paths.sh <shared-directory>}"
[[ -d "$shared" && ! -L "$shared" ]] || { echo 'Shared directory missing or symlinked' >&2; exit 2; }
[[ -d "$shared/uploads" && ! -L "$shared/uploads" ]] || {
  echo 'Uploads directory missing or symlinked' >&2
  exit 2
}
printf 'uploads\n'

archives="$shared/archives"
[[ ! -L "$archives" ]] || { echo 'Archive directory is symlinked' >&2; exit 2; }
[[ ! -e "$archives" ]] && exit 0
[[ -d "$archives" && ! -L "$archives" ]] || {
  echo 'Archive directory is not a regular directory' >&2
  exit 2
}
shopt -s nullglob
for archive_dir in "$archives"/*; do
  [[ ! -L "$archive_dir" ]] || { echo 'Archive directory is symlinked' >&2; exit 2; }
  [[ -d "$archive_dir" ]] || continue
  archive_id="${archive_dir##*/}"
  [[ "$archive_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$ ]] || {
    echo 'Invalid archive directory ID' >&2
    exit 2
  }
  path="$archive_dir/uploads"
  [[ -e "$path" || -L "$path" ]] || continue
  [[ -d "$path" && ! -L "$path" ]] || {
    echo 'Archive uploads directory is not a regular directory' >&2
    exit 2
  }
  printf 'archives/%s/uploads\n' "$archive_id"
done
