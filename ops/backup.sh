#!/usr/bin/env bash
set -euo pipefail
# App and systemd share the persisted schedule and SQLite lease.
# Configure retention/storage in the admin UI, not BACKUP_REMOTE.
base=/var/www/drevo.kiiko.ru
if ! printenv DATABASE_PATH >/dev/null; then
  export DATABASE_PATH="$base/shared/drevo.sqlite"
fi
cd "$base/shared"
exec /opt/drevo-node/bin/node --experimental-strip-types "$base/current/ops/backup-cli.ts" "$@"
