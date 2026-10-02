#!/usr/bin/env bash
set -euo pipefail
umask 077

# Restore the latest local backup into a disposable directory and start a
# second PostgreSQL instance on a private Unix socket. Never touches PGDATA.
[[ "$(id -un)" == postgres ]] || { echo 'Run as postgres' >&2; exit 2; }
[[ -d /var/lib/pgbackrest ]] || { echo 'Repository missing' >&2; exit 2; }
expected_database="${1:-}"
(( $# == 1 || $# == 2 )) || { echo 'Expected database and optional pair manifest path' >&2; exit 2; }
manifest_path="${2:-}"
if [[ -n "$manifest_path" ]]; then
  [[ "$manifest_path" =~ ^/var/tmp/drevo-restore-pair\.[a-zA-Z0-9]+/pg/refs\.jsonl$ ]] || {
    echo 'Unexpected pair manifest path' >&2
    exit 2
  }
  [[ ! -e "$manifest_path" && ! -L "$manifest_path" ]] || {
    echo 'Pair manifest already exists' >&2
    exit 2
  }
fi
exec 9>/var/lib/postgresql/drevo-physical-restore.lock
flock -n 9 || { echo 'Another physical restore rehearsal is running' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
database="$(python3 "$script_dir/restore-preflight.py" \
  "$expected_database" /var/lib/postgresql/18/main /var/tmp)"
started_at="$(date +%s)"
work_dir="$(mktemp -d /var/tmp/drevo-physical-restore.XXXXXX)"
[[ "$work_dir" =~ ^/var/tmp/drevo-physical-restore\.[a-zA-Z0-9]+$ ]] || exit 2
data_dir="$work_dir/data"
socket_dir="$work_dir/socket"
cleanup() {
  result=$?
  trap - EXIT
  if [[ -f "$data_dir/postmaster.pid" ]]; then
    if ! /usr/lib/postgresql/18/bin/pg_ctl -D "$data_dir" -m fast -w stop; then
      echo "Isolated PostgreSQL did not stop; retained $work_dir for inspection" >&2
      exit 1
    fi
  fi
  if [[ ! -f "$data_dir/postmaster.pid" && "$work_dir" =~ ^/var/tmp/drevo-physical-restore\.[a-zA-Z0-9]+$ ]]; then
    rm -rf -- "$work_dir"
  fi
  exit "$result"
}
trap cleanup EXIT
mkdir -m 700 "$socket_dir"

# An external tablespace could otherwise be restored to its original path.
extra_tablespaces="$(psql -XAtq -v ON_ERROR_STOP=1 -h /var/run/postgresql -d postgres -c "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global')")"
[[ "$extra_tablespaces" == 0 ]] || { echo 'External tablespaces need explicit safe mapping' >&2; exit 2; }
bash "$script_dir/restore-pgbackrest-physical.sh" \
  drevo "$data_dir" "$work_dir/tablespaces"
restored_at="$(date +%s)"

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
# Command-line settings override any postgresql.auto.conf copied from the source.
# In particular, the rehearsal must never listen on TCP or archive into the live repo.
/usr/lib/postgresql/18/bin/pg_ctl -D "$data_dir" \
  -o "-c config_file=$work_dir/postgresql.conf -c data_directory=$data_dir -c hba_file=$work_dir/pg_hba.conf -c port=55433 -c listen_addresses= -c unix_socket_directories=$socket_dir -c archive_mode=off" \
  -l "$work_dir/server.log" -w start
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
isolation="$(psql -XAtq -v ON_ERROR_STOP=1 -h "$socket_dir" -p 55433 -d postgres \
  -c "SELECT current_setting('listen_addresses') || '|' || current_setting('archive_mode') || '|' || current_setting('unix_socket_directories') || '|' || current_setting('data_directory')")"
[[ "$isolation" == "|off|$socket_dir|$data_dir" ]] || {
  echo 'Restored cluster is not fully isolated from production' >&2
  exit 1
}
archive_state="$(psql -XAtq -v ON_ERROR_STOP=1 -h "$socket_dir" -p 55433 -d "$database" \
  -c 'SELECT count(*),coalesce(max(revision),0) FROM public.archives')"
[[ "$archive_state" =~ ^[1-9][0-9]*\|[0-9]+$ ]] || {
  echo "Production archive missing from restored database $database" >&2
  exit 1
}
ready_at="$(date +%s)"
if [[ -n "$manifest_path" ]]; then
  # Only archive IDs, normalized file names, source kinds and known sizes are
  # exported; the query reads the isolated restored cluster, never production.
  ( set -C; psql -XqAt -v ON_ERROR_STOP=1 -h "$socket_dir" -p 55433 \
      -d "$database" -f "$script_dir/media-filesystem-refs.sql" > "$manifest_path" )
fi
printf 'PHYSICAL_RESTORE_VERIFIED database=%s archives=%s revision=%s restore_seconds=%s ready_seconds=%s\n' \
  "$database" "${archive_state%%|*}" "${archive_state#*|}" \
  "$(( restored_at - started_at ))" "$(( ready_at - started_at ))"
