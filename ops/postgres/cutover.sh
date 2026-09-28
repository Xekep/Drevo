#!/usr/bin/env bash
# Explicit one-time operator action, never invoked automatically by deployment.
set -euo pipefail
umask 077
[[ "$(id -u)" == 0 ]] || exit 2
base=/var/www/drevo.kiiko.ru
shared="$base/shared"
node=/opt/drevo-node/bin/node
release=$(readlink -f "$base/current")
[[ "$release" =~ ^/var/www/drevo\.kiiko\.ru/releases/[0-9a-f]{40}-[0-9]+$ ]] || exit 2
test -f "$release/src/server/store-database.ts"
test -f "$release/ops/postgres/010_runtime_services.sql"
test ! -e "$shared/postgres.active"
test ! -e /run/drevo-maintenance
grep -Fq 'if (-f /run/drevo-maintenance) { return 503; }' /etc/nginx/sites-available/drevo.kiiko.ru-ssl
nginx -t
exec 9>"$base/deploy.lock"
flock -w 120 9
set -a
. /etc/drevo.env
set +a
test "${DATABASE_BACKEND:-sqlite}" = sqlite
stamp=$(date -u +%Y%m%dT%H%M%SZ)
database="drevo_archive_$(date -u +%Y%m%d_%H%M%S)"
archive_id=legacy-primary
stage="/var/backups/drevo-cutover/$stamp"
install -d -m 750 -o root -g site_drevo_grp /var/backups/drevo-cutover "$stage"
cp -p /etc/drevo.env "$stage/environment.before"
chmod 600 "$stage/environment.before"
timer_was_active=$(systemctl is-active drevo-backup.timer || true)
frozen=false
committed=false
rollback() {
  result=$?
  trap - EXIT
  if test "$frozen" = true && test "$committed" = false; then
    echo 'Cutover failed before public writes; restoring the unchanged SQLite runtime' >&2
    systemctl stop drevo || true
    cp -p "$stage/environment.before" /etc/drevo.env
    rm -f -- "$shared/postgres.active"
    if systemctl start drevo && curl --retry 10 --retry-connrefused --retry-delay 1 --fail --silent http://127.0.0.1:3107/api/health > /dev/null; then
      rm -f /run/drevo-maintenance
    else
      echo 'Rollback requires operator attention; maintenance remains enabled' >&2
    fi
  fi
  if test "$timer_was_active" = active; then systemctl start drevo-backup.timer || true; fi
  exit "$result"
}
trap rollback EXIT
# The reverse proxy blocks new requests while direct localhost health checks
# remain available. Stop both possible SQLite writers before taking the copy.
touch /run/drevo-maintenance
frozen=true
systemctl stop drevo-backup.timer drevo-backup.service drevo
python3 - "$shared/drevo.sqlite" "$stage/snapshot.sqlite" <<'PY'
import sqlite3,sys
with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
    assert target.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not target.execute('PRAGMA foreign_key_check').fetchall()
PY
cp "$shared/drevo.sqlite.secrets.key" "$stage/snapshot.sqlite.secrets.key"
chown root:site_drevo_grp "$stage/snapshot.sqlite" "$stage/snapshot.sqlite.secrets.key"
chmod 640 "$stage/snapshot.sqlite" "$stage/snapshot.sqlite.secrets.key"
tar --exclude='uploads/.*' -czf "$stage/files-and-key.tar.gz" -C "$shared" uploads drevo.sqlite.secrets.key
sha256sum "$stage/snapshot.sqlite" "$stage/files-and-key.tar.gz" > "$stage/SHA256SUMS"
sudo -u postgres createdb -O site_drevo "$database"
runtime_env=(PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=site_drevo PGDATABASE="$database" ARCHIVE_ID="$archive_id")
sudo -u site_drevo env "${runtime_env[@]}" "$node" --experimental-strip-types "$release/ops/postgres/import-sqlite.ts" \
  "$stage/snapshot.sqlite" "$shared/uploads" "$archive_id" "${INITIAL_ADMIN_YANDEX_ID:-}" > "$stage/import-result.json"
# Run only direct reads, not a second public/local-auth HTTP server on production.
sudo -u site_drevo env "${runtime_env[@]}" DATABASE_BACKEND=postgres "$node" --experimental-strip-types --input-type=module - "$release" "$stage/snapshot.sqlite" <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const [release,snapshot]=process.argv.slice(2);
const { openArchive,readArchive }=await import(pathToFileURL(release+'/src/server/database.ts'));
const { storeDatabase }=await import(pathToFileURL(release+'/src/server/store-database.ts'));
const source=storeDatabase(new DatabaseSync(snapshot,{readOnly:true}));
const expected=await readArchive(source);
const live=await openArchive(snapshot,expected.family);
try { assert.deepEqual(await live.read(),expected); console.log(JSON.stringify({verified:true,revision:expected.revision,people:expected.family.people.length})); }
finally { await live.close(); await source.close(); }
JS
sudo -u postgres pg_dump -Fc "$database" > "$stage/initial.pgdump"
test -s "$stage/initial.pgdump"
python3 - "$database" "$archive_id" <<'PY'
import pathlib,sys
p=pathlib.Path('/etc/drevo.env')
values={'DATABASE_BACKEND':'postgres','PGHOST':'/var/run/postgresql','PGPORT':'5432','PGUSER':'site_drevo','PGDATABASE':sys.argv[1],'ARCHIVE_ID':sys.argv[2]}
lines=[line for line in p.read_text().splitlines() if line.split('=',1)[0] not in values]
p.write_text('\n'.join(lines+[k+'='+v for k,v in values.items()])+'\n')
PY
printf '%s\n' "$database" > "$shared/postgres.active"
chmod 644 "$shared/postgres.active"
systemctl start drevo
curl --retry 15 --retry-connrefused --retry-delay 1 --fail --silent http://127.0.0.1:3107/api/health > "$stage/health.json"
python3 - "$stage/snapshot.sqlite" "$stage/health.json" <<'PY'
import json,sqlite3,sys
with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True) as db: revision=db.execute('SELECT revision FROM archive WHERE id=1').fetchone()[0]
health=json.load(open(sys.argv[2])); assert health.get('ok') is True and health.get('revision')==revision
PY
pid=$(systemctl show drevo --property=MainPID --value)
test "$pid" -gt 0
if find "/proc/$pid/fd" -lname '*drevo.sqlite*' | grep -q .; then
  echo 'Application still has a SQLite descriptor open' >&2; exit 1
fi
connections=$(sudo -u postgres psql -XAtq -d postgres -v target="$database" <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE datname=:'target' AND application_name='drevo';
SQL
)
test "$connections" -gt 0
# Beyond this point requests may write to PostgreSQL. Never automatically return
# to the old SQLite copy after opening the site to users.
committed=true
rm -f /run/drevo-maintenance
echo "POSTGRES_CUTOVER_COMPLETE database=$database backup=$stage"
