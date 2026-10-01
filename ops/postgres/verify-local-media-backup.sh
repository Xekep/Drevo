#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -un)" == site_drevo ]] || { echo 'Run as site_drevo' >&2; exit 2; }
shared=/var/www/drevo.kiiko.ru/shared
script_dir="$(dirname "$(readlink -f "$0")")"
backup_dir="$shared/backups/media"
cd "$shared"
name="$(find "$backup_dir" -maxdepth 1 -type f -name 'media-*.tar.gz' -printf '%f\n' | sort -r | head -n 1)"
[[ "$name" =~ ^media-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || { echo 'No valid media backup' >&2; exit 2; }
(cd "$backup_dir" && sha256sum -c -- "$name.sha256")
work_dir="$(mktemp -d /var/tmp/drevo-media-restore.XXXXXX)"
[[ "$work_dir" =~ ^/var/tmp/drevo-media-restore\.[a-zA-Z0-9]+$ ]] || exit 2
trap 'rm -rf -- "$work_dir"' EXIT
tar -xzf "$backup_dir/$name" -C "$work_dir" --no-same-owner
[[ -d "$work_dir/uploads" ]] || { echo 'Restored uploads missing' >&2; exit 1; }
source_paths="$("$script_dir/media-backup-paths.sh" "$shared")"
restored_paths="$("$script_dir/media-backup-paths.sh" "$work_dir")"
[[ "$source_paths" == "$restored_paths" ]] || {
  echo 'Restored archive directory list differs from current source' >&2
  exit 1
}
mapfile -t paths <<< "$source_paths"
files=0
for path in "${paths[@]}"; do
  count="$(find "$work_dir/$path" -type f | wc -l)"
  files=$(( files + count ))
  diff -qr -- "$shared/$path" "$work_dir/$path" >/dev/null || {
    echo 'Restored media differs from current uploads; check for concurrent changes' >&2
    exit 1
  }
done
(( files > 0 )) || { echo 'Restored uploads empty' >&2; exit 1; }
printf 'MEDIA_RESTORE_VERIFIED files=%s\n' "$files"
