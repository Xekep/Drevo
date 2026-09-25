#!/usr/bin/env bash
set -euo pipefail
base=/var/www/drevo.kiiko.ru
exec 9>"$base/shared/backups/.backup.lock"
flock -w 120 9
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$base/shared/backups/full-$stamp.tar.gz"
database="$base/shared/drevo.sqlite"
temporary=$(mktemp -d "$base/shared/backups/.full-$stamp-XXXXXX")
cleanup() { rm -rf -- "$temporary"; rm -f -- "$target.partial"; }
trap cleanup EXIT
umask 077
python3 - "$base/shared" <<'PY'
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1])
needed = sum(p.stat().st_size for p in (root / 'uploads').iterdir() if p.is_file())
needed += (root / 'drevo.sqlite').stat().st_size * 2
if shutil.disk_usage(root).free < needed + 256 * 1024 * 1024:
    raise SystemExit('Insufficient free space for a full backup; working data preserved')
PY
python3 - "$database" "$temporary/drevo.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as dest:
    source.backup(dest)
    assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
# Оригиналы имеют неизменяемые UUID-имена и автоматически не удаляются:
# файлы, появившиеся после SQLite snapshot, являются безопасным излишком.
extra=()
if test -f "$database.secrets.key"; then
  cp "$database.secrets.key" "$temporary/drevo.sqlite.secrets.key"
  extra=(drevo.sqlite.secrets.key)
fi
tar --exclude='uploads/.*' -czf "$target.partial" -C "$temporary" drevo.sqlite "${extra[@]}" -C "$base/shared" uploads
mv -- "$target.partial" "$target"
sha256sum "$target" > "$target.sha256"
find "$base/shared/backups" -maxdepth 1 -type f -name 'full-*.tar.gz' -mtime +30 -delete
find "$base/shared/backups" -maxdepth 1 -type f -name 'full-*.tar.gz.sha256' -mtime +30 -delete
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rsync -a --protect-args "$target" "$target.sha256" "$BACKUP_REMOTE/"
fi
