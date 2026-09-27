#!/usr/bin/env bash
set -euo pipefail

# Restore the latest local backup into a disposable directory and start a
# second PostgreSQL instance on a private Unix socket. Never touches PGDATA.
[[ "$(id -un)" == postgres ]] || { echo 'Run as postgres' >&2; exit 2; }
[[ -d /var/lib/pgbackrest ]] || { echo 'Repository missing' >&2; exit 2; }
work_dir="$(mktemp -d /var/tmp/drevo-physical-restore.XXXXXX)"
[[ "$work_dir" =~ ^/var/tmp/drevo-physical-restore\.[a-zA-Z0-9]+$ ]] || exit 2
data_dir="$work_dir/data"
socket_dir="$work_dir/socket"
mkdir -m 700 "$socket_dir"
cleanup() {
  if [[ -f "$data_dir/postmaster.pid" ]]; then
    if ! /usr/lib/postgresql/18/bin/pg_ctl -D "$data_dir" -m fast -w stop; then
      echo "Isolated PostgreSQL did not stop; retained $work_dir for inspection" >&2
      return
    fi
  fi
  if [[ ! -f "$data_dir/postmaster.pid" && "$work_dir" =~ ^/var/tmp/drevo-physical-restore\.[a-zA-Z0-9]+$ ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

# An external tablespace could otherwise be restored to its original path.
extra_tablespaces="$(psql -XAtq -v ON_ERROR_STOP=1 -d postgres -c "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global')")"
[[ "$extra_tablespaces" == 0 ]] || { echo 'External tablespaces need explicit safe mapping' >&2; exit 2; }
pgbackrest --stanza=drevo --pg1-path="$data_dir" --type=immediate --target-action=promote restore

cat > "$work_dir/postgresql.conf" <<EOF
data_directory = '$data_dir'
hba_file = '$work_dir/pg_hba.conf'
port = 55433
listen_addresses = ''
unix_socket_directories = '$socket_dir'
archive_mode = off
logging_collector = off
EOF
printf 'local all all trust\n' > "$work_dir/pg_hba.conf"
/usr/lib/postgresql/18/bin/pg_ctl -D "$data_dir" -o "-c config_file=$work_dir/postgresql.conf" -l "$work_dir/server.log" -w start
for attempt in {1..120}; do
  recovery_state="$(psql -XAtq -v ON_ERROR_STOP=1 -h "$socket_dir" -p 55433 -d postgres -c 'SELECT pg_is_in_recovery()')"
  [[ "$recovery_state" == f ]] && break
  sleep 1
done
[[ "$recovery_state" == f ]] || {
  echo "Restored cluster is still in recovery: $recovery_state" >&2
  tail -n 20 "$work_dir/server.log" >&2
  exit 1
}
restored_databases="$(psql -XAtq -v ON_ERROR_STOP=1 -h "$socket_dir" -p 55433 -d postgres -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'drevo_migration%'")"
[[ "$restored_databases" =~ ^[1-9][0-9]*$ ]] || { echo 'Migration databases absent in restored cluster' >&2; exit 1; }
printf 'PHYSICAL_RESTORE_VERIFIED databases=%s\n' "$restored_databases"
