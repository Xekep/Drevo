#!/usr/bin/env bash
set -euo pipefail
base=/var/www/drevo.kiiko.ru
release_id=${1:?Release identifier required}
[[ "$release_id" =~ ^[a-zA-Z0-9-]{7,80}$ ]] || exit 2
release="$base/releases/$release_id"
test -f "$release/dist/index.html"
test -f "$release/src/server/index.ts"
exec 9>"$base/deploy.lock"
flock -w 120 9
previous=$(readlink -f "$base/current" || true)
# sqlite3.backup creates a consistent copy even when the running database uses WAL.
if test -f "$base/shared/drevo.sqlite"; then
  python3 - "$base/shared/drevo.sqlite" "$base/shared/backups/$release_id.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as dest:
    source.backup(dest)
PY
fi
ln -s "$release" "$base/current-next"
mv -Tf "$base/current-next" "$base/current"
healthy=false
if sudo /usr/local/sbin/drevo-service-restart; then
  for attempt in $(seq 1 30); do
    if curl --fail --silent --max-time 2 http://127.0.0.1:3107/api/health | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True' 2>/dev/null; then healthy=true; break; fi
    sleep 1
  done
fi
if test "$healthy" != true; then
  if test -n "$previous" && test -d "$previous"; then
    ln -s "$previous" "$base/current-rollback"
    mv -Tf "$base/current-rollback" "$base/current"
    sudo /usr/local/sbin/drevo-service-restart
  fi
  echo "Deployment failed; previous code restored. Database backup retained." >&2
  exit 1
fi
echo "Deployed $release_id to https://drevo.kiiko.ru"
