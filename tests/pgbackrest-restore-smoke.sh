#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -un)" == postgres ]] || { echo 'Run as postgres' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/.." && pwd)"
work_dir="$(mktemp -d /tmp/drevo-pgbackrest-smoke.XXXXXX)"
[[ "$work_dir" =~ ^/tmp/drevo-pgbackrest-smoke\.[a-zA-Z0-9]+$ ]] || exit 2
primary="$work_dir/primary"
restored="$work_dir/restored"
primary_socket="$work_dir/primary-socket"
restored_socket="$work_dir/restored-socket"
config="$work_dir/pgbackrest.conf"

cleanup() {
  result=$?
  trap - EXIT
  for data_dir in "$restored" "$primary"; do
    if [[ -f "$data_dir/postmaster.pid" ]]; then
      pg_ctl -D "$data_dir" -m fast -w stop || result=1
    fi
  done
  if [[ "$work_dir" =~ ^/tmp/drevo-pgbackrest-smoke\.[a-zA-Z0-9]+$ ]]; then
    rm -rf -- "$work_dir"
  fi
  exit "$result"
}
trap cleanup EXIT

mkdir -p "$work_dir/repo" "$work_dir/log" "$work_dir/lock" \
  "$primary_socket" "$restored_socket"
cat > "$config" <<EOF
[global]
repo1-path=$work_dir/repo
log-path=$work_dir/log
lock-path=$work_dir/lock
compress-type=none

[smoke]
pg1-path=$primary
pg1-socket-path=$primary_socket
pg1-port=55434
EOF

initdb -D "$primary" --no-instructions > "$work_dir/initdb.log"
cat >> "$primary/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$primary_socket'
port = 55434
archive_mode = on
archive_command = 'pgbackrest --config=$config --stanza=smoke archive-push %p'
EOF
pg_ctl -D "$primary" -l "$work_dir/primary.log" -w start
psql_primary=(psql -XAtq -v ON_ERROR_STOP=1 -h "$primary_socket" -p 55434 -d postgres)
pgbackrest --config="$config" --stanza=smoke stanza-create
pgbackrest --config="$config" --stanza=smoke check
"${psql_primary[@]}" -c 'CREATE TABLE restore_smoke (id integer PRIMARY KEY, value text NOT NULL)'
"${psql_primary[@]}" -c "INSERT INTO restore_smoke VALUES (1, 'before backup')"
"${psql_primary[@]}" <<'SQL'
CREATE TABLE archives(id text NOT NULL);
CREATE TABLE people(archive_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE family_unions(archive_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE relations(archive_id text NOT NULL, sources jsonb NOT NULL);
CREATE TABLE photos(archive_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE history(archive_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE media_upload_grants(archive_id text NOT NULL, url text NOT NULL, expires_ms bigint NOT NULL);
CREATE TABLE media_originals(archive_id text NOT NULL, url text NOT NULL, size_bytes bigint NOT NULL);
CREATE TABLE documents(archive_id text NOT NULL, file_name text NOT NULL, file_size bigint NOT NULL);
CREATE TABLE workflow_stages(archive_id text NOT NULL, kind text NOT NULL,
  expires_at bigint NOT NULL, data jsonb NOT NULL, directory text);
INSERT INTO archives VALUES ('tree-a');
INSERT INTO people VALUES ('tree-a', '{"photo":"/media/one.jpg"}');
INSERT INTO media_originals VALUES ('tree-a', '/media/one.jpg', 3);
SQL
pgbackrest --config="$config" --stanza=smoke --type=full backup

# This row exists only in archived WAL, not in the completed full backup.
"${psql_primary[@]}" -c "INSERT INTO restore_smoke VALUES (2, 'after backup')"
"${psql_primary[@]}" -c 'SELECT pg_switch_wal()' > /dev/null
pgbackrest --config="$config" --stanza=smoke check
pg_ctl -D "$primary" -m fast -w stop

bash "$root_dir/ops/postgres/restore-pgbackrest-physical.sh" \
  smoke "$restored" "$work_dir/tablespaces" "$config"
pg_ctl -D "$restored" -l "$work_dir/restored.log" -w \
  -o "-c port=55435 -c listen_addresses= -c unix_socket_directories=$restored_socket -c archive_mode=off" start
psql_restored=(psql -XAtq -v ON_ERROR_STOP=1 -h "$restored_socket" -p 55435 -d postgres)
for attempt in {1..120}; do
  state="$("${psql_restored[@]}" -c 'SELECT pg_is_in_recovery()')"
  [[ "$state" == f ]] && break
  sleep 1
done
[[ "$state" == f ]] || { echo 'Restored cluster did not finish recovery' >&2; exit 1; }
rows="$("${psql_restored[@]}" -c 'SELECT string_agg(value, $$,$$ ORDER BY id) FROM restore_smoke')"
[[ "$rows" == 'before backup,after backup' ]] || {
  echo "Restored cluster did not replay post-backup WAL: $rows" >&2
  exit 1
}
isolation="$("${psql_restored[@]}" -c "SELECT current_setting('listen_addresses') || '|' || current_setting('archive_mode') || '|' || current_setting('unix_socket_directories')")"
[[ "$isolation" == "|off|$restored_socket" ]] || {
  echo "Restored cluster is not isolated: $isolation" >&2
  exit 1
}
manifest="$work_dir/restored-refs.jsonl"
"${psql_restored[@]}" -f "$root_dir/ops/postgres/media-filesystem-refs.sql" > "$manifest"
mkdir -p "$work_dir/media-source/uploads"
printf abc > "$work_dir/media-source/uploads/one.jpg"
media_backup="$work_dir/media-20261002T000000Z.tar.gz"
tar -C "$work_dir/media-source" -czf "$media_backup" uploads
printf '%s  %s\n' "$(sha256sum "$media_backup" | cut -d ' ' -f 1)" \
  "${media_backup##*/}" > "$media_backup.sha256"
python3 "$root_dir/ops/postgres/verify-media-archive.py" "$media_backup" \
  --scratch-parent "$work_dir" --reference-manifest "$manifest"
echo 'PGBACKREST_RESTORE_SMOKE_VERIFIED post_backup_wal=1 isolated_socket=1'
