#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -un)" == postgres ]] || { echo 'Run as postgres' >&2; exit 2; }
free_kib="$(df -Pk /var/lib/pgbackrest | awk 'NR == 2 {print $4}')"
[[ "$free_kib" =~ ^[0-9]+$ ]] || { echo 'Cannot measure free disk space' >&2; exit 2; }
(( free_kib >= 8 * 1024 * 1024 )) || { echo 'Less than 8 GiB free' >&2; exit 1; }
[[ "$(psql -XAtq -v ON_ERROR_STOP=1 -d postgres -c 'SHOW archive_mode')" == on ]] || {
  echo 'PostgreSQL WAL archiving is disabled' >&2
  exit 1
}
archiver_failed="$(psql -XAtq -v ON_ERROR_STOP=1 -d postgres -c "SELECT CASE WHEN last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time) THEN 1 ELSE 0 END FROM pg_stat_archiver")"
[[ "$archiver_failed" == 0 ]] || { echo 'Latest WAL archive attempt failed' >&2; exit 1; }
pgbackrest --stanza=drevo --output=json info | python3 -c '
import json, sys, time
items = json.load(sys.stdin)
assert len(items) == 1 and items[0]["status"]["code"] == 0, "Repository is unhealthy"
backups = items[0]["backup"]
assert backups, "No backup exists"
age = time.time() - max(backup["timestamp"]["stop"] for backup in backups)
assert age < 36 * 3600, f"Latest backup is {age / 3600:.1f} hours old"
'
