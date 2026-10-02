#!/usr/bin/env bash
set -euo pipefail

# Read the root-owned cutover marker, then drop privileges before restore.
[[ "$(id -u)" == 0 ]] || { echo 'Run as root through systemd' >&2; exit 2; }
marker=/var/www/drevo.kiiko.ru/shared/postgres.active
[[ -f "$marker" && ! -L "$marker" && "$(stat -c %u "$marker")" == 0 ]] || {
  echo 'Production PostgreSQL marker is missing or not root-owned' >&2
  exit 2
}
database="$(cat -- "$marker")"
[[ "$database" =~ ^drevo_archive_[0-9]{8}_[0-9]{6}$ ]] || {
  echo 'Production PostgreSQL marker has an unexpected database name' >&2
  exit 2
}
if (( $# == 0 )); then
  exec runuser -u postgres -- /usr/local/sbin/drevo-pgbackrest-restore-check "$database"
fi
[[ "${1:-}" == --with-media && $# -le 2 ]] || {
  echo 'Usage: drevo-run-restore-rehearsal [--with-media [legacy-archive-id]]' >&2
  exit 2
}
legacy_archive_id="${2:-}"
if [[ -n "$legacy_archive_id" && ! "$legacy_archive_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$ ]]; then
  echo 'Invalid legacy archive ID' >&2
  exit 2
fi

backup_dir=/var/www/drevo.kiiko.ru/shared/backups/media
name="$(find "$backup_dir" -maxdepth 1 -type f -name 'media-*.tar.gz' -printf '%f\n' | sort -r | sed -n '1p')"
[[ "$name" =~ ^media-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || {
  echo 'No valid media backup' >&2
  exit 2
}
pair_dir="$(mktemp -d /var/tmp/drevo-restore-pair.XXXXXX)"
[[ "$pair_dir" =~ ^/var/tmp/drevo-restore-pair\.[a-zA-Z0-9]+$ ]] || exit 2
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$pair_dir" =~ ^/var/tmp/drevo-restore-pair\.[a-zA-Z0-9]+$ ]]; then
    rm -rf -- "$pair_dir"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chown root:postgres "$pair_dir"
chmod 710 "$pair_dir"
install -d -m 700 -o postgres -g postgres "$pair_dir/pg"
manifest="$pair_dir/pg/refs.jsonl"

runuser -u postgres -- /usr/local/sbin/drevo-pgbackrest-restore-check "$database" "$manifest"
arguments=("$backup_dir/$name" --reference-manifest "$manifest")
if [[ -n "$legacy_archive_id" ]]; then
  arguments+=(--legacy-archive-id "$legacy_archive_id")
fi
python3 /usr/local/sbin/verify-media-archive.py "${arguments[@]}"
