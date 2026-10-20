import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";

export const runtimeServiceTables = [
  "personal_bookmarks",
  "personal_people_filters",
  "audit_reverts",
  "upload_limits",
  "share_links",
  "share_link_activity",
  "published_people",
  "geocode_cache",
  "migrations",
  "face_descriptors",
  "ai_settings",
  "ai_usage",
  "research_suggestions",
  "ai_usage_models",
  "ai_chats",
  "ai_chat_messages",
  "research_categories",
  "research_resources",
  "workflow_stages",
  "document_upload_requests",
  "backup_settings",
  "backup_catalog",
  "backup_job",
  "media_upload_grants",
  "user_tree_preferences",
  "notification_cursors",
  "notification_reads",
  "vk_auth_settings",
] as const;

/** Caller owns the fresh-snapshot import transaction. No working database is
 * modified until every table has passed a value-for-value round trip.
 */
export async function backfillRuntimeServicesInTransaction(
  client: pg.Client,
  archiveId: string,
) {
  await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
    archiveId,
  ]);
  await client.query(readFileSync(new URL("./032_upload_limits.sql", import.meta.url), "utf8"));
  await client.query(
    readFileSync(
      new URL("./010_runtime_services.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(readFileSync(new URL("./079_ai_chat_stop.sql", import.meta.url), "utf8"));
  await client.query(readFileSync(new URL("./098_archive_notifications.sql", import.meta.url), "utf8"));
  await client.query(readFileSync(new URL("./107_personal_research.sql", import.meta.url), "utf8"));
  await client.query(readFileSync(new URL("./082_ai_provider_cleanup.sql", import.meta.url), "utf8"));
  await client.query(
    readFileSync(
      new URL("./011_vk_auth_settings.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    readFileSync(
      new URL("./019_published_people.sql", import.meta.url),
      "utf8",
    ),
  );
  const counts: Record<string, number> = {};
  await client.query(readFileSync(new URL("./046_tree_generation_limits.sql", import.meta.url), "utf8"));
  await client.query(readFileSync(new URL("./100_tree_load_animation.sql", import.meta.url), "utf8"));
  await client.query(
    readFileSync(
      new URL("./020_code_interpreter.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    readFileSync(
      new URL("./021_account_archive_directory.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    readFileSync(
      new URL("./012_ai_role_profiles.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const table of runtimeServiceTables) {
    const targetTable = table.startsWith("notification_") ? `archive_${table}` : table;
    const metadata = (
      await client.query(
        "SELECT columns FROM service_snapshot_tables WHERE archive_id=$1 AND name=$2",
        [archiveId, table],
      )
    ).rows[0];
    if ((!metadata || !metadata.columns?.length) &&
      (table.startsWith("notification_") || table.startsWith("personal_") || table === "audit_reverts")) continue;
    if (!metadata)
      throw new Error(`Отсутствует таблица для переноса: ${table}`);
    const columns: string[] = metadata.columns;
    if (
      !Array.isArray(columns) ||
      !columns.every((name) => /^[a-z_]+$/.test(name))
    )
      throw new Error(`Некорректные столбцы: ${table}`);
    if (
      (
        await client.query(
          `SELECT 1 FROM ${targetTable} WHERE archive_id=$1 LIMIT 1`,
          [archiveId],
        )
      ).rowCount
    )
      throw new Error(`Таблица уже заполнена: ${table}`);
    const rows = (
      await client.query(
        "SELECT ordinal,data FROM service_snapshot_rows WHERE archive_id=$1 AND table_name=$2 ORDER BY ordinal",
        [archiveId, table],
      )
    ).rows;
    const ordinal = table === "share_links" || table === "face_descriptors";
    const fields = ["archive_id", ...columns, ...(ordinal ? ["ordinal"] : [])];
    const sql = `INSERT INTO ${targetTable}(${fields.map((field) => `"${field}"`).join(",")}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING ${columns.map((field) => `"${field}"`).join(",")}`;
    // JSONB comes back parsed, int8 as text. Read PostgreSQL's actual column
    // types so round-trip verification distinguishes JSON strings from text.
    const types = new Map(
      (
        await client.query(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
          [targetTable],
        )
      ).rows.map((row) => [row.column_name, row.data_type]),
    );
    const personal = table.startsWith("personal_");
    const previousAccount = personal
      ? (await client.query("SELECT current_setting('drevo.account_id',true) AS id")).rows[0].id || ""
      : "";
    for (const row of rows) {
      const input = row.data as Record<string, unknown>;
      if (personal) {
        // A standalone local installation has one trusted identity rather than
        // a platform account. Its personal saves move to the chosen tree owner.
        if (input.user_id === "local") {
          const owner = (await client.query("SELECT user_id FROM archive_owners WHERE archive_id=$1", [archiveId])).rows[0];
          if (!owner) throw new Error("Не определён владелец локальных сохранений");
          input.user_id = owner.user_id;
        }
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [String(input.user_id)]);
      }
      const result = (
        await client.query(sql, [
          archiveId,
          ...columns.map((field) => input[field]),
          ...(ordinal ? [row.ordinal] : []),
        ])
      ).rows[0];
      for (const field of columns) {
        if (result[field] === null) continue;
        if (types.get(field) === "bigint")
          result[field] = Number(result[field]);
        if (types.get(field) === "jsonb") {
          if (
            !isDeepStrictEqual(result[field], JSON.parse(String(input[field])))
          )
            throw new Error(`JSON не совпал после переноса: ${table}.${field}`);
          result[field] = input[field];
        }
      }
      if (!isDeepStrictEqual(result, input))
        throw new Error(`Данные не совпали после переноса: ${table}`);
    }
    if (personal) await client.query("SELECT set_config('drevo.account_id',$1,true)", [previousAccount]);
    counts[table] = rows.length;
    const sequenceColumn = ordinal
      ? "ordinal"
      : ["ai_usage", "ai_chat_messages"].includes(table)
        ? "id"
        : null;
    if (sequenceColumn)
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}','${sequenceColumn}'),GREATEST(COALESCE((SELECT max(${sequenceColumn}) FROM ${table}),0)+1,1),false)`,
      );
  }
  return counts;
}
