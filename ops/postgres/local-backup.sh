#!/usr/bin/env bash
set -euo pipefail

# Run as postgres from the daily systemd timer. Never remove backups manually:
# pgBackRest expires complete backup chains together with the WAL they require.
stanza="drevo"
repo="/var/lib/pgbackrest"
minimum_free_kib=$((8 * 1024 * 1024))

[[ "$(id -un)" == postgres ]] || { echo 'Run as postgres' >&2; exit 2; }
[[ -d "$repo" ]] || { echo 'pgBackRest repository is missing' >&2; exit 2; }
free_kib="$(df -Pk "$repo" | awk 'NR == 2 {print $4}')"
[[ "$free_kib" =~ ^[0-9]+$ ]] || { echo 'Cannot measure free disk space' >&2; exit 2; }
if (( free_kib < minimum_free_kib )); then
  echo "Skipping backup: less than 8 GiB free on repository filesystem" >&2
  exit 1
fi

day="$(date -u +%u)"
if [[ "$day" == 7 ]]; then
  backup_type=full
else
  backup_type=diff
fi
pgbackrest --stanza="$stanza" --type="$backup_type" --log-level-console=info backup
pgbackrest --stanza="$stanza" --output=json info | python3 -c 'import json,sys; data=json.load(sys.stdin); assert len(data)==1 and data[0]["status"]["code"]==0 and data[0]["backup"], "No healthy pgBackRest backup"'
