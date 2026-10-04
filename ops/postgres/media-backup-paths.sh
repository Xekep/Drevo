#!/usr/bin/env bash
set -euo pipefail

shared="${1:?Usage: media-backup-paths.sh <shared-directory>}"
[[ -d "$shared" && ! -L "$shared" ]] || { echo 'Shared directory missing or symlinked' >&2; exit 2; }
[[ -d "$shared/uploads" && ! -L "$shared/uploads" ]] || {
  echo 'Uploads directory missing or symlinked' >&2
  exit 2
}
printf 'uploads\n'

# The platform cleanup key is immutable and paired with the database ledger.
# It is never placed in a downloadable per-archive backup.
platform_key="$shared/ai-provider-cleanup.v1.key"
if [[ -e "$platform_key" || -L "$platform_key" ]]; then
  [[ -f "$platform_key" && ! -L "$platform_key" ]] || {
    echo 'AI cleanup key is not a regular file' >&2; exit 2;
  }
  mode="$(stat -c %a "$platform_key")"
  (( (8#$mode & 0077) == 0 )) || {
    echo 'AI cleanup key permissions are too broad' >&2; exit 2;
  }
  printf 'ai-provider-cleanup.v1.key\n'
fi

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
