#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -un)" == site_drevo ]] || { echo 'Run as site_drevo' >&2; exit 2; }
backup_dir=/var/www/drevo.kiiko.ru/shared/backups/media
cd /var/www/drevo.kiiko.ru/shared
name="$(find "$backup_dir" -maxdepth 1 -type f -name 'media-*.tar.gz' -printf '%f\n' | sort -r | head -n 1)"
[[ "$name" =~ ^media-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ && -f "$backup_dir/$name.sha256" ]] || {
  echo 'No complete media backup' >&2
  exit 1
}
age=$(( $(date +%s) - $(stat -c %Y "$backup_dir/$name") ))
(( age < 36 * 3600 )) || { echo 'Latest media backup is older than 36 hours' >&2; exit 1; }
free_kib="$(df -Pk "$backup_dir" | awk 'NR == 2 {print $4}')"
[[ "$free_kib" =~ ^[0-9]+$ ]] || exit 2
(( free_kib >= 8 * 1024 * 1024 )) || { echo 'Less than 8 GiB free' >&2; exit 1; }
