#!/usr/bin/env bash
set -euo pipefail
base=/var/www/drevo.kiiko.ru
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$base/shared/backups/full-$stamp.tar.gz"
database="$base/shared/drevo.sqlite"
temporary=$(mktemp -d "$base/shared/backups/.full-$stamp-XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
umask 077
python3 - "$database" "$temporary/drevo.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as dest:
    source.backup(dest)
    assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
# Оригиналы имеют неизменяемые UUID-имена и автоматически не удаляются:
# файлы, появившиеся после SQLite snapshot, являются безопасным излишком.
tar -czf "$target" -C "$temporary" drevo.sqlite -C "$base/shared" uploads
sha256sum "$target" > "$target.sha256"
find "$base/shared/backups" -maxdepth 1 -type f -name 'full-*.tar.gz' -mtime +30 -delete
find "$base/shared/backups" -maxdepth 1 -type f -name 'full-*.tar.gz.sha256' -mtime +30 -delete
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rsync -a --protect-args "$target" "$target.sha256" "$BACKUP_REMOTE/"
fi
