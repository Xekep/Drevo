#!/usr/bin/env bash
set -euo pipefail

# Temporary local protection for original photographs and documents while the
# application still uses SQLite. Run as site_drevo; never delete the source.
shared=/var/www/drevo.kiiko.ru/shared
source_dir="$shared/uploads"
backup_dir="$shared/backups/media"
[[ "$(id -un)" == site_drevo ]] || { echo 'Run as site_drevo' >&2; exit 2; }
[[ -d "$source_dir" && ! -L "$source_dir" ]] || { echo 'Uploads directory missing' >&2; exit 2; }
cd "$shared"
install -d -m 700 "$backup_dir"
source_kib="$(du -sk "$source_dir" | awk '{print $1}')"
free_kib="$(df -Pk "$backup_dir" | awk 'NR == 2 {print $4}')"
[[ "$source_kib" =~ ^[0-9]+$ && "$free_kib" =~ ^[0-9]+$ ]] || exit 2
(( free_kib > 8 * 1024 * 1024 + 2 * source_kib )) || {
  echo 'Not enough free space for a media backup and 8 GiB reserve' >&2
  exit 1
}
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="media-$stamp.tar.gz"
[[ ! -e "$backup_dir/$name" ]] || { echo 'Backup already exists' >&2; exit 2; }
temporary="$(mktemp "$backup_dir/.media-XXXXXXXX")"
trap 'rm -f -- "$temporary" "$temporary.sha256"' EXIT
tar --exclude='uploads/.*' -C "$shared" -czf "$temporary" uploads
tar -tzf "$temporary" >/dev/null
hash="$(sha256sum "$temporary" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$name" > "$temporary.sha256"
chmod 600 "$temporary" "$temporary.sha256"
mv -- "$temporary" "$backup_dir/$name"
mv -- "$temporary.sha256" "$backup_dir/$name.sha256"

mapfile -t names < <(find "$backup_dir" -maxdepth 1 -type f -name 'media-*.tar.gz' -printf '%f\n' | sort -r)
for ((index = 3; index < ${#names[@]}; index++)); do
  old="${names[index]}"
  [[ "$old" =~ ^media-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || continue
  rm -f -- "$backup_dir/$old" "$backup_dir/$old.sha256"
done
printf 'MEDIA_BACKUP_VERIFIED file=%s source_kib=%s\n' "$name" "$source_kib"
