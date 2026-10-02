#!/usr/bin/env bash
set -euo pipefail

# Safe on an already configured cluster: installs a separate timer only.
[[ "${1:-}" == --apply && "$(id -u)" == 0 ]] || {
  echo 'Usage: sudo bash setup-restore-rehearsal.sh --apply' >&2
  exit 2
}
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
marker=/var/www/drevo.kiiko.ru/shared/postgres.active
[[ -f "$marker" && ! -L "$marker" && "$(stat -c %u "$marker")" == 0 ]] || {
  echo 'PostgreSQL cutover marker is missing or not root-owned' >&2
  exit 2
}
[[ "$(pg_lsclusters -h | awk '$1 == 18 && $2 == "main" { print $6 }')" == /var/lib/postgresql/18/main ]] || {
  echo 'Unexpected PostgreSQL cluster path' >&2
  exit 2
}
for command in pgbackrest python3 flock runuser; do
  command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 2; }
done
install -m 755 "$script_dir/verify-physical-restore.sh" /usr/local/sbin/drevo-pgbackrest-restore-check
install -m 755 "$script_dir/restore-preflight.py" /usr/local/sbin/restore-preflight.py
install -m 755 "$script_dir/run-restore-rehearsal.sh" /usr/local/sbin/drevo-run-restore-rehearsal
install -m 644 "$script_dir/drevo-pgbackrest-restore-check.service" /etc/systemd/system/
install -m 644 "$script_dir/drevo-pgbackrest-restore-check.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now drevo-pgbackrest-restore-check.timer
echo 'Restore rehearsal timer installed; run systemctl start drevo-pgbackrest-restore-check.service for the first check'
