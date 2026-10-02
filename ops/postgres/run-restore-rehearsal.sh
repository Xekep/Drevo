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
exec runuser -u postgres -- /usr/local/sbin/drevo-pgbackrest-restore-check "$database"
