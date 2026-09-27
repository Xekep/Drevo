#!/usr/bin/env bash
set -euo pipefail

# Deliberately limited to the existing PostgreSQL 18/main cluster.
# Run as root with --apply after reviewing the server's disk and cluster.
[[ "${1:-}" == --apply && "$(id -u)" == 0 ]] || {
  echo 'Usage: sudo bash setup-local-backup.sh --apply' >&2
  exit 2
}
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v pgbackrest >/dev/null || { echo 'Install pgbackrest first' >&2; exit 2; }
[[ "$(pg_lsclusters -h | awk '$1 == 18 && $2 == "main" { print $6 }')" == /var/lib/postgresql/18/main ]] || {
  echo 'Unexpected PostgreSQL cluster path' >&2
  exit 2
}
[[ ! -e /etc/pgbackrest/pgbackrest.conf ]] || {
  echo 'Existing pgBackRest configuration must be reviewed manually' >&2
  exit 2
}
free_kib="$(df -Pk /var/lib/postgresql | awk 'NR == 2 {print $4}')"
(( free_kib >= 8 * 1024 * 1024 )) || { echo 'Less than 8 GiB free' >&2; exit 2; }

install -d -m 750 -o postgres -g postgres /var/lib/pgbackrest /var/log/pgbackrest
install -d -m 750 -o root -g postgres /etc/pgbackrest
install -m 640 -o root -g postgres "$script_dir/local-backup.conf.example" /etc/pgbackrest/pgbackrest.conf
install -m 755 "$script_dir/local-backup.sh" /usr/local/sbin/drevo-pgbackrest-backup
install -m 755 "$script_dir/local-backup-health.sh" /usr/local/sbin/drevo-pgbackrest-health
install -m 644 "$script_dir/drevo-pgbackrest-backup.service" /etc/systemd/system/
install -m 644 "$script_dir/drevo-pgbackrest-backup.timer" /etc/systemd/system/
install -m 644 "$script_dir/drevo-pgbackrest-health.service" /etc/systemd/system/
install -m 644 "$script_dir/drevo-pgbackrest-health.timer" /etc/systemd/system/

pg_conftool 18 main set archive_command 'pgbackrest --stanza=drevo archive-push %p'
pg_conftool 18 main set archive_mode on
pg_ctlcluster 18 main restart
runuser -u postgres -- pgbackrest --stanza=drevo stanza-create
runuser -u postgres -- pgbackrest --stanza=drevo check
runuser -u postgres -- pgbackrest --stanza=drevo --type=full backup
systemctl daemon-reload
systemctl enable --now drevo-pgbackrest-backup.timer
systemctl enable --now drevo-pgbackrest-health.timer
systemctl start drevo-pgbackrest-health.service
runuser -u postgres -- pgbackrest --stanza=drevo info
