#!/usr/bin/env bash
set -euo pipefail

# Rehearsal only: dump an isolated migration database, restore it into a new
# temporary database, compare every public table, and remove the rehearsal.
source_db="${1:?Usage: verify-restore.sh <drevo_migration_database>}"
if [[ ! "$source_db" =~ ^drevo_migration(_[a-zA-Z0-9_]+)?$ ]]; then
  echo "Only isolated drevo_migration databases can be rehearsed" >&2
  exit 2
fi
for command in pg_dump pg_restore psql createdb dropdb; do
  command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 2; }
done

restore_db="drevo_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
work_dir="$(mktemp -d /tmp/drevo-pg-restore.XXXXXX)"
restore_created=0
cleanup() {
  if [[ "$restore_created" == 1 && "$restore_db" =~ ^drevo_restore_check_[0-9]+_[0-9]+$ ]]; then
    dropdb --if-exists -- "$restore_db" || true
  fi
  rm -f -- "$work_dir/archive.dump" "$work_dir/source-tables" "$work_dir/restored-tables"
  rmdir -- "$work_dir" || true
}
trap cleanup EXIT

actual_db="$(psql -XAtq -v ON_ERROR_STOP=1 -d "$source_db" -c 'SELECT current_database()')"
[[ "$actual_db" == "$source_db" ]] || { echo "Source database mismatch" >&2; exit 2; }
pg_dump -Fc --no-owner --no-acl -d "$source_db" -f "$work_dir/archive.dump"
createdb -T template0 -- "$restore_db"
restore_created=1
pg_restore --exit-on-error --no-owner --no-acl -d "$restore_db" "$work_dir/archive.dump"

table_sql="SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
psql -XAtq -v ON_ERROR_STOP=1 -d "$source_db" -c "$table_sql" > "$work_dir/source-tables"
psql -XAtq -v ON_ERROR_STOP=1 -d "$restore_db" -c "$table_sql" > "$work_dir/restored-tables"
cmp -s "$work_dir/source-tables" "$work_dir/restored-tables" || {
  echo "Restored table list differs" >&2
  exit 1
}

table_count=0
total_rows=0
while IFS= read -r table; do
  [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Unexpected table name" >&2; exit 2; }
  sql="SELECT count(*),md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) FROM public.$table t"
  source_sum="$(psql -XAtq -v ON_ERROR_STOP=1 -d "$source_db" -c "$sql")"
  restored_sum="$(psql -XAtq -v ON_ERROR_STOP=1 -d "$restore_db" -c "$sql")"
  [[ "$source_sum" == "$restored_sum" ]] || { echo "Mismatch after restore: $table" >&2; exit 1; }
  table_count=$((table_count + 1))
  total_rows=$((total_rows + ${source_sum%%|*}))
done < "$work_dir/source-tables"

printf 'RESTORE_VERIFIED source=%s tables=%s rows=%s\n' "$source_db" "$table_count" "$total_rows"
