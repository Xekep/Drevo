import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";

export const runtimeServiceTables = [
  "share_links",
  "share_link_activity",
  "geocode_cache",
  "migrations",
  "face_descriptors",
  "mcp_tokens",
  "ai_settings",
  "ai_usage",
  "mcp_usage",
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
  await client.query(
    readFileSync(
      new URL("./010_runtime_services.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    readFileSync(
      new URL("./011_vk_auth_settings.sql", import.meta.url),
      "utf8",
    ),
  );
  const counts: Record<string, number> = {};
  await client.query(
    readFileSync(
      new URL("./012_ai_role_profiles.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const table of runtimeServiceTables) {
    const metadata = (
      await client.query(
        "SELECT columns FROM service_snapshot_tables WHERE archive_id=$1 AND name=$2",
        [archiveId, table],
      )
    ).rows[0];
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
          `SELECT 1 FROM ${table} WHERE archive_id=$1 LIMIT 1`,
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
    const sql = `INSERT INTO ${table}(${fields.map((field) => `"${field}"`).join(",")}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING ${columns.map((field) => `"${field}"`).join(",")}`;
    // JSONB comes back parsed, int8 as text. Read PostgreSQL's actual column
    // types so round-trip verification distinguishes JSON strings from text.
    const types = new Map(
      (
        await client.query(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
          [table],
        )
      ).rows.map((row) => [row.column_name, row.data_type]),
    );
    for (const row of rows) {
      const input = row.data as Record<string, unknown>;
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
    counts[table] = rows.length;
    const sequenceColumn = ordinal
      ? "ordinal"
      : ["ai_usage", "mcp_usage", "ai_chat_messages"].includes(table)
        ? "id"
        : null;
    if (sequenceColumn)
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}','${sequenceColumn}'),GREATEST(COALESCE((SELECT max(${sequenceColumn}) FROM ${table}),0)+1,1),false)`,
      );
  }
  return counts;
}
