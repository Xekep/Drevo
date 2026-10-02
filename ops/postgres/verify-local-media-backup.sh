#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -un)" == site_drevo ]] || { echo 'Run as site_drevo' >&2; exit 2; }
shared=/var/www/drevo.kiiko.ru/shared
script_dir="$(dirname "$(readlink -f "$0")")"
backup_dir="$shared/backups/media"
name="$(find "$backup_dir" -maxdepth 1 -type f -name 'media-*.tar.gz' -printf '%f\n' | sort -r | head -n 1)"
[[ "$name" =~ ^media-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || { echo 'No valid media backup' >&2; exit 2; }
python3 "$script_dir/verify-media-archive.py" "$backup_dir/$name"
