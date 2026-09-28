#!/usr/bin/env bash
# Install root-owned as /usr/local/sbin/drevo-postgres-maintenance.
# Release code always executes as site_drevo, never as root.
set -euo pipefail
umask 077
base=/var/www/drevo.kiiko.ru
action=${1:?Action required}
release_id=${2:?Release required}
[[ "$release_id" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
release="$base/releases/$release_id"
test "$(readlink -f "$release")" = "$release"
test -f "$release/src/server/index.ts"
set -a
. /etc/drevo.env
set +a
test "${DATABASE_BACKEND:-}" = postgres
test "${PGHOST:-}" = /var/run/postgresql
test "${PGUSER:-}" = site_drevo
[[ "${PGDATABASE:-}" =~ ^drevo_[a-z0-9_]+$ ]] || exit 2
[[ "${ARCHIVE_ID:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$ ]] || exit 2
node=/opt/drevo-node/bin/node
runtime_env=(DATABASE_BACKEND=postgres PGHOST="$PGHOST" PGPORT="${PGPORT:-5432}" PGUSER="$PGUSER" PGDATABASE="$PGDATABASE" ARCHIVE_ID="$ARCHIVE_ID")
if test "$action" = gc; then
  exec sudo -u site_drevo env "${runtime_env[@]}" "$node" --experimental-strip-types \
    "$release/src/server/media-gc.ts" "$base/shared/drevo.sqlite" "$base/shared/uploads"
fi
test "$action" = preflight || exit 2
previous_id=${3:?Previous release required}
[[ "$previous_id" =~ ^[0-9a-f]{40}-[0-9]+$ ]] || exit 2
previous="$base/releases/$previous_id"
test "$(readlink -f "$previous")" = "$previous"
backup="$base/shared/backups/$release_id.pgdump"
fixture="drevo_preflight_$(openssl rand -hex 8)"
dump_stage=$(mktemp -d /var/tmp/drevo-postgres-dump-XXXXXX)
stage=$(mktemp -d /var/tmp/drevo-postgres-preflight-XXXXXX)
chown site_drevo "$stage"
cleanup() {
  sudo -u postgres /usr/bin/dropdb --if-exists "$fixture"
  case "$stage" in /var/tmp/drevo-postgres-preflight-*) rm -rf -- "$stage";; *) exit 2;; esac
  case "$dump_stage" in /var/tmp/drevo-postgres-dump-*) rm -rf -- "$dump_stage";; *) exit 2;; esac
}
trap cleanup EXIT
# Never open/chown a deploy-writable path as root: it may be replaced with a
# symlink. The private dump is published with exclusive creation as app user.
sudo -u postgres /usr/bin/pg_dump --format=custom --dbname="$PGDATABASE" > "$dump_stage/native.pgdump"
sudo -u site_drevo /bin/sh -c 'set -C; umask 077; cat > "$1"' sh "$backup" < "$dump_stage/native.pgdump"
test -s "$backup"
sudo -u postgres /usr/bin/createdb --owner=site_drevo "$fixture"
sudo -u site_drevo env "${runtime_env[@]}" /usr/bin/pg_restore --exit-on-error --no-owner --dbname="$fixture" "$backup"
for candidate in "$release" "$previous"; do
  sudo -u site_drevo env "${runtime_env[@]}" PGDATABASE="$fixture" PUBLIC_ORIGIN=https://migration-check.invalid \
    "$node" --experimental-strip-types "$release/ops/postgres/check-runtime.mjs" "$candidate" "$stage/drevo.sqlite"
done
echo 'PostgreSQL backup, restore and previous-release compatibility verified'
