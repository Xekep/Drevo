#!/usr/bin/env bash
set -euo pipefail
# No dump, restore, runtime-role privilege change or HBA rewrite.
[[ "${1:-}" == --apply && "$(id -u)" == 0 ]] || { echo 'Usage: sudo bash setup-platform-backup.sh --apply' >&2; exit 2; }
config=/etc/drevo.env
operator_config=/etc/drevo-platform-backup.env
[[ -f "$config" && ! -L "$config" && "$(stat -c %u "$config")" == 0 ]] || { echo 'Unsafe application environment' >&2; exit 2; }
[[ $(( 8#$(stat -c %a "$config") & 8#022 )) == 0 ]] || { echo 'Environment must not be writable by group/others' >&2; exit 2; }
set -a
source "$config"
set +a
[[ "${DATABASE_BACKEND:-}" == postgres && "${PGDATABASE:-}" =~ ^[a-zA-Z0-9_]{1,63}$ ]] || { echo 'Expected configured PostgreSQL database' >&2; exit 2; }
[[ "${PGHOST:-}" == /var/run/postgresql && "${PGPORT:-5432}" =~ ^[0-9]{1,5}$ ]] || { echo 'Expected local cluster; review remote provisioning separately' >&2; exit 2; }
role=drevo_platform_backup
secret=""
if [[ -e "$operator_config" ]]; then
  [[ -f "$operator_config" && ! -L "$operator_config" && "$(stat -c %u "$operator_config")" == 0 && "$(stat -c %a "$operator_config")" == 600 ]] || { echo 'Unsafe operator environment' >&2; exit 2; }
  source "$operator_config"
  [[ "${PLATFORM_BACKUP_PGUSER:-}" == "$role" && "${PLATFORM_BACKUP_PGPASSWORD:-}" =~ ^[a-f0-9]{64}$ ]] || { echo 'Review existing operator credentials' >&2; exit 2; }
  secret=$PLATFORM_BACKUP_PGPASSWORD
else
  secret=$(openssl rand -hex 32)
fi
stage=$(mktemp -d /run/drevo-platform-backup.XXXXXX)
chmod 700 "$stage"
trap 'rm -rf -- "$stage"' EXIT
cat >"$stage/setup.sql" <<SQL
SET log_statement=none;
SET log_min_duration_statement=-1;
SET log_min_duration_sample=-1;
DO \$setup\$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$role' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication))
    THEN RAISE EXCEPTION 'Existing operator role has unrelated privileges'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='$role')
    THEN RAISE EXCEPTION 'Operator must not own database objects'; END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
    JOIN pg_roles parent ON parent.oid=m.roleid WHERE member.rolname='$role' AND parent.rolname<>'pg_read_all_data')
    THEN RAISE EXCEPTION 'Existing operator has unrelated memberships'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$role')
    THEN CREATE ROLE $role; END IF;
END
\$setup\$;
ALTER ROLE $role LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT CONNECTION LIMIT 2 PASSWORD '$secret';
ALTER ROLE $role SET default_transaction_read_only=on;
GRANT pg_read_all_data TO $role;
GRANT CONNECT ON DATABASE "$PGDATABASE" TO $role;
SQL
chmod 600 "$stage/setup.sql"
if ! PGHOST=/var/run/postgresql PGPASSWORD='' runuser -u postgres -- psql -U postgres -X -q -v ON_ERROR_STOP=1 -p "${PGPORT:-5432}" -d "$PGDATABASE" <"$stage/setup.sql" >"$stage/result" 2>&1; then
  echo 'Operator provisioning failed' >&2; exit 1
fi
printf 'PLATFORM_BACKUP_PGUSER=%s\nPLATFORM_BACKUP_PGPASSWORD=%s\nPLATFORM_BACKUP_PGHOST=127.0.0.1\nPLATFORM_BACKUP_PGPORT=%s\n' "$role" "$secret" "${PGPORT:-5432}" >"$stage/operator.env"
chmod 600 "$stage/operator.env"
install -m 600 -o root -g root "$stage/operator.env" "$operator_config"
# Credentials are environment variables, never argv or console output.
if ! PGHOST=127.0.0.1 PGPORT="${PGPORT:-5432}" PGDATABASE="$PGDATABASE" PGUSER="$role" PGPASSWORD="$secret" \
  runuser -u site_drevo -- psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN NOT rolsuper AND rolbypassrls AND current_setting('default_transaction_read_only')='on' THEN 'platform_backup_operator_ready' ELSE 'invalid_operator' END FROM pg_roles WHERE rolname=current_user" >"$stage/ready" 2>"$stage/error"; then
  echo 'Operator login failed; check local TCP authentication' >&2; exit 1
fi
grep -qx platform_backup_operator_ready "$stage/ready" || { echo 'Unexpected operator capabilities' >&2; exit 1; }
echo 'platform_backup_operator_ready'
echo 'Add EnvironmentFile=/etc/drevo-platform-backup.env to existing app/backup services; restart in a release window.'
