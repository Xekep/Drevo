#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -un)" == site_drevo ]] || { echo 'Run as site_drevo' >&2; exit 2; }
shared=/var/www/drevo.kiiko.ru/shared
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
files="$(find "$work_dir/uploads" -type f | wc -l)"
(( files > 0 )) || { echo 'Restored uploads empty' >&2; exit 1; }
diff -qr -- "$shared/uploads" "$work_dir/uploads" >/dev/null || {
  echo 'Restored media differs from current uploads; check for concurrent changes' >&2
  exit 1
}
printf 'MEDIA_RESTORE_VERIFIED files=%s\n' "$files"
