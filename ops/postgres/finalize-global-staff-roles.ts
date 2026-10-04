import pg, { type Client } from "pg";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Mode = "inventory" | "apply" | "validate";
type Counts = {
  total: string;
  legacyAdmin: string;
  legacyResearcher: string;
  unknown: string;
  validated: boolean;
};

export class GlobalRoleFinalizationError extends Error {}

const migrationLock = 186743291;
const expectedCheck = /^CHECK \(\(role = ANY \(ARRAY\['reader'::text, 'relative'::text\]\)\)\)(?: ENFORCED)?(?: NOT VALID)?$/;

async function transaction<T>(client: Client, readOnly: boolean, work: () => Promise<T>) {
  await client.query(readOnly
    ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    : "BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='35s'");
    const role = await client.query<{ privileged: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS privileged
       FROM pg_roles WHERE rolname=current_user`,
    );
    if (!role.rows[0]?.privileged)
      throw new GlobalRoleFinalizationError("Требуется PostgreSQL SUPERUSER или BYPASSRLS");
    await client.query("SET LOCAL row_security=off");
    if ((await client.query<{ mode: string }>(
      "SELECT current_setting('session_replication_role') AS mode")).rows[0]?.mode !== "origin")
      throw new GlobalRoleFinalizationError("Триггеры PostgreSQL должны работать в обычном режиме");
    const value = await work();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function lockMigration(client: Client) {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1) AS locked", [migrationLock]);
  if (!result.rows[0]?.locked)
    throw new GlobalRoleFinalizationError("Миграция 090 занята; повторите операцию");
}

async function checkSchema(client: Client) {
  const table = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
     WHERE oid=to_regclass('public.archive_memberships')`);
  if (!table.rows[0]?.relrowsecurity || !table.rows[0]?.relforcerowsecurity)
    throw new GlobalRoleFinalizationError("Неожиданная схема членства или RLS");
  const policy = await client.query<{ present: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='archive_memberships'
        AND policyname='archive_scope') AS present`);
  if (!policy.rows[0]?.present)
    throw new GlobalRoleFinalizationError("Не найдена политика области архива");
  const trigger = await client.query<{ present: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('public.archive_memberships')
        AND tgname='normalize_archive_member_role_before_write'
        AND tgenabled='O' AND NOT tgisinternal
        AND tgfoid=to_regprocedure('public.normalize_archive_member_role()')) AS present`);
  if (!trigger.rows[0]?.present)
    throw new GlobalRoleFinalizationError("Не найден действующий триггер миграции 090");
  const constraint = await client.query<{ definition: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS definition,convalidated AS validated
     FROM pg_constraint WHERE conrelid=to_regclass('public.archive_memberships')
       AND conname='archive_memberships_role_check' AND contype='c'`);
  const definition = constraint.rows[0]?.definition.replace(/\s+/g, " ");
  if (!definition || !expectedCheck.test(definition))
    throw new GlobalRoleFinalizationError("Неожиданный CHECK местной роли");
  return constraint.rows[0].validated;
}

async function counts(client: Client, validated: boolean): Promise<Counts> {
  const result = await client.query<{
    total: string; legacy_admin: string; legacy_researcher: string; unknown: string;
  }>(`SELECT count(*)::text AS total,
      count(*) FILTER (WHERE role='admin')::text AS legacy_admin,
      count(*) FILTER (WHERE role='researcher')::text AS legacy_researcher,
      count(*) FILTER (WHERE role NOT IN ('reader','relative','admin','researcher'))::text AS unknown
    FROM public.archive_memberships`);
  const row = result.rows[0];
  return { total: row.total, legacyAdmin: row.legacy_admin,
    legacyResearcher: row.legacy_researcher, unknown: row.unknown, validated };
}

function invalidCount(value: Counts) {
  return BigInt(value.legacyAdmin) + BigInt(value.legacyResearcher) + BigInt(value.unknown);
}

export async function inventoryGlobalStaffRoles(client: Client) {
  return transaction(client, true, async () => counts(client, await checkSchema(client)));
}

export async function applyGlobalStaffRoles(
  client: Client, { batchSize = 500, maxBatches = 100 } = {},
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 ||
      !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000)
    throw new GlobalRoleFinalizationError("Неверный предел порций");
  let updated = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const changed = await transaction(client, false, async () => {
      await lockMigration(client);
      const validated = await checkSchema(client);
      if (batch === 0) {
        const before = await counts(client, validated);
        if (BigInt(before.unknown) !== BigInt(0))
          throw new GlobalRoleFinalizationError("Обнаружены неизвестные местные роли; запись не изменена");
      }
      const result = await client.query(
        `WITH picked AS (
           SELECT archive_id,user_id FROM public.archive_memberships
           WHERE role IN ('admin','researcher')
           ORDER BY archive_id,user_id LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE public.archive_memberships AS member SET role='relative'
         FROM picked WHERE member.archive_id=picked.archive_id
           AND member.user_id=picked.user_id
           AND member.role IN ('admin','researcher')`, [batchSize]);
      return result.rowCount || 0;
    });
    updated += changed;
    if (changed === 0) break;
  }
  const remaining = await inventoryGlobalStaffRoles(client);
  return { updated, remaining, complete: invalidCount(remaining) === BigInt(0) };
}

export async function validateGlobalStaffRoles(client: Client) {
  return transaction(client, false, async () => {
    await lockMigration(client);
    const validated = await checkSchema(client);
    const before = await counts(client, validated);
    if (invalidCount(before) !== BigInt(0))
      throw new GlobalRoleFinalizationError("Остались несовместимые местные роли; CHECK не проверен");
    if (!validated)
      await client.query(
        "ALTER TABLE public.archive_memberships VALIDATE CONSTRAINT archive_memberships_role_check");
    const after = await counts(client, await checkSchema(client));
    if (!after.validated)
      throw new GlobalRoleFinalizationError("CHECK местной роли не подтверждён");
    return after;
  });
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (!(["inventory", "apply", "validate"] as string[]).includes(mode) || extra.length)
    throw new GlobalRoleFinalizationError(
      "Использование: finalize-global-staff-roles.ts inventory|apply|validate");
  const client = new pg.Client({ application_name: "drevo-global-role-finalization" });
  try {
    await client.connect();
    const result = mode === "inventory" ? await inventoryGlobalStaffRoles(client)
      : mode === "apply" ? await applyGlobalStaffRoles(client)
        : await validateGlobalStaffRoles(client);
    console.log(JSON.stringify({ mode: mode as Mode, ...result }));
    if (mode === "apply" && "complete" in result && !result.complete) process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]))
  void main().catch((error) => {
    const reason = error instanceof GlobalRoleFinalizationError
      ? error.message : `Ошибка PostgreSQL${(error as { code?: string }).code
        ? ` (${(error as { code: string }).code})` : ""}`;
    console.error(reason);
    process.exitCode = 1;
  });
