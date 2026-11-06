import type { DatabaseSync } from "node:sqlite";

export type PortableSnapshotColumn = { name: string; type: string };
export function portableIdentifier(value: string) {
  if (!/^[a-z_]+$/.test(value))
    throw new Error("Неизвестный столбец резервной копии");
  return `"${value}"`;
}

/** One bridge used by the real exporter and the PostgreSQL schema contract. */
export function portableSnapshotSchema(target: DatabaseSync) {
  const projections: Record<string, string> = {
    archive:
      "SELECT 1 AS id,title,description,demo::integer AS demo,revision FROM archives",
    users: "SELECT * FROM runtime_users",
    auth_sessions:
      "SELECT s.* FROM account_sessions s WHERE EXISTS (SELECT 1 FROM runtime_users u WHERE u.id=s.user_id)",
    access_settings: "SELECT * FROM runtime_access_settings",
    tree_settings: "SELECT * FROM runtime_tree_settings",
    audit_entries: "SELECT * FROM archive_audit_entries",
    audit_people: "SELECT * FROM archive_audit_people",
    notification_cursors: "SELECT * FROM archive_notification_cursors",
    notification_reads: "SELECT * FROM archive_notification_reads",
    person_comments:
      "SELECT archive_id,id,person_id,author_id,author_name,created_ms,text,updated_ms,attachments::text AS attachments FROM person_comments",
    source_catalog:
      "SELECT archive_id,id,data::text AS data,version FROM source_catalog",
    // This SQLite-only derived table is rebuilt from the same consistent
    // original rows instead of querying a nonexistent PostgreSQL table.
    media_storage_usage:
      "SELECT 1 AS id,count(*) AS files,coalesce(sum(size_bytes),0) AS bytes FROM media_originals",
  };
  const ordered = new Set([
    "people",
    "relations",
    "photos",
    "photo_tags",
    "documents",
    "document_people",
    "share_links",
    "face_descriptors",
  ]);

  return target
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => {
      const name = String(row.name);
      const columns: PortableSnapshotColumn[] = target
        .prepare(`PRAGMA table_info(${portableIdentifier(name)})`)
        .all()
        .map((column) => ({
          name: String(column.name),
          type: String(column.type).toUpperCase(),
        }));
      if (
        [
          "platform_ai_cleanup_keys",
          "platform_ai_conversations",
          "platform_ai_input_files",
        ].includes(name)
      )
        return { name, columns, select: null };
      const names = columns
        .map((column) => portableIdentifier(column.name))
        .join(",");
      const projection =
        name === "ai_chats"
          ? `SELECT ${columns
              .map((column) =>
                column.name === "yandex_conversation_id" ||
                column.name === "provider_cleanup_ref"
                  ? `NULL AS ${portableIdentifier(column.name)}`
                  : portableIdentifier(column.name),
              )
              .join(",")} FROM ai_chats`
          : projections[name] || `SELECT * FROM ${portableIdentifier(name)}`;
      return {
        name,
        columns,
        select: `SELECT ${names} FROM (${projection}${ordered.has(name) ? " ORDER BY ordinal" : ""}) AS saved`,
      };
    });
}

export function portableSnapshotValue(
  table: string,
  column: PortableSnapshotColumn,
  value: unknown,
) {
  if (typeof value === "boolean" && column.type === "INTEGER")
    return Number(value);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  )
    return value;
  if (column.type === "BLOB" && value instanceof Uint8Array) return value;
  throw new Error(`Некорректное поле копии: ${table}.${column.name}`);
}
