#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == --apply && "$(id -u)" == 0 ]] || {
  echo 'Usage: sudo bash setup-local-media-backup.sh --apply' >&2
  exit 2
}
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -d /var/www/drevo.kiiko.ru/shared/uploads ]] || { echo 'Uploads directory missing' >&2; exit 2; }
id site_drevo >/dev/null
install -m 755 "$script_dir/local-media-backup.sh" /usr/local/sbin/drevo-media-backup
install -m 755 "$script_dir/media-backup-paths.sh" /usr/local/sbin/media-backup-paths.sh
install -m 755 "$script_dir/local-media-backup-health.sh" /usr/local/sbin/drevo-media-backup-health
install -m 644 "$script_dir/drevo-media-backup.service" /etc/systemd/system/
install -m 644 "$script_dir/drevo-media-backup.timer" /etc/systemd/system/
install -m 644 "$script_dir/drevo-media-backup-health.service" /etc/systemd/system/
install -m 644 "$script_dir/drevo-media-backup-health.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start drevo-media-backup.service
systemctl enable --now drevo-media-backup.timer
systemctl enable --now drevo-media-backup-health.timer
systemctl start drevo-media-backup-health.service
