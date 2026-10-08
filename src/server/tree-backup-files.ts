import { DatabaseSync } from "node:sqlite";
import { lstat, link, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { documentFileTypeFromName } from "../shared/document-file.ts";

/** A portable family copy is not a transport for sessions or provider credentials. */
export function sanitizeTreeBackup(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN");
    for (const name of ["auth_sessions", "mcp_tokens", "ai_chats", "ai_chat_messages",
      "platform_ai_input_files", "platform_ai_conversations", "platform_ai_cleanup_keys",
      "ai_settings", "backup_catalog", "backup_job", "backup_settings"])
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
        db.exec(`DELETE FROM ${name}`);
    db.exec("COMMIT; VACUUM");
  } finally { db.close(); }
}

/** Read only this archive's snapshot. Hard links pin committed originals while
 * TAR streams; a concurrent deletion before pinning fails the entire copy. */
export async function stageTreeBackupFiles(snapshot: string, root: string, destination: string) {
  const db = new DatabaseSync(snapshot, { readOnly: true });
  const names = new Set<string>();
  const expected = new Map<string, number>();
  const addMedia = (text: string) => {
    let saved: unknown = text;
    if (text.startsWith("{") || text.startsWith("[")) {
      try { saved = JSON.parse(text); } catch { /* A plain text column. */ }
    }
    const pending: unknown[] = [saved];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "string") {
        // Whole root-relative URLs only: external /media paths and a .jpg
        // prefix inside another filename are not local originals.
        const match = /^\/media\/([a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|tif|pdf))(?:[?#].*)?$/.exec(value);
        if (match) names.add(match[1]);
      } else if (Array.isArray(value)) {
        for (const child of value) pending.push(child);
      } else if (value && typeof value === "object") {
        for (const child of Object.values(value)) pending.push(child);
      }
    }
  };
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((r) => String(r.name)));
    for (const table of ["people", "photos", "history", "family_unions", "relations", "source_catalog"])
      if (tables.has(table))
        for (const row of db.prepare(`SELECT * FROM ${table}`).iterate())
          for (const value of Object.values(row)) if (typeof value === "string") addMedia(value);
    if (tables.has("documents"))
      for (const row of db.prepare("SELECT file_name,file_size FROM documents").iterate()) {
        const name = String(row.file_name);
        if (!/^[a-zA-Z0-9-]+\.[a-z]+$/.test(name) || !documentFileTypeFromName(name))
          throw new Error("Некорректный путь документа в копии");
        names.add(name); expected.set(name, Number(row.file_size));
      }
    if (tables.has("person_comments"))
      for (const row of db.prepare("SELECT attachments FROM person_comments").iterate())
        for (const file of JSON.parse(String(row.attachments)) as { id: string; size: number }[]) {
          if (!/^[a-f0-9-]{36}$/.test(file.id)) throw new Error("Некорректное вложение комментария");
          const name = "discussion-files/" + file.id;
          names.add(name); expected.set(name, file.size);
        }
  } finally { db.close(); }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const source = join(root, "uploads", name), target = join(destination, name);
    const info = await lstat(source);
    if (!info.isFile() || (expected.has(name) && expected.get(name) !== info.size))
      throw new Error("Оригинал изменился или отсутствует. Копия древа не создана");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await link(source, target);
  }
  return names.size;
}
