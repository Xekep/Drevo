import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mediaPattern } from "./media.ts";
import { configuredDatabaseBackend } from "./store-database.ts";

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const fileNamePattern = /^[a-zA-Z0-9-]+\.(jpg|png|webp|gif|pdf)$/;

function referencedMedia(db: DatabaseSync, includeBackups = true) {
  const result = new Set<string>();
  for (const row of db.prepare("SELECT data FROM people").all()) {
    const value = JSON.parse(String(row.data)) as { photo?: unknown };
    if (typeof value.photo !== "string") continue;
    const match = mediaPattern.exec(value.photo);
    if (match) result.add(match[1]);
  }
  for (const row of db.prepare("SELECT data FROM photos").all()) {
    const value = JSON.parse(String(row.data)) as { url?: unknown };
    if (typeof value.url !== "string") continue;
    const match = mediaPattern.exec(value.url);
    if (match) result.add(match[1]);
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='documents'",
      )
      .get()
  )
    for (const row of db.prepare("SELECT file_name FROM documents").all())
      if (
        typeof row.file_name === "string" &&
        /^[a-f0-9-]{36}\.pdf$/.test(row.file_name)
      )
        result.add(row.file_name);
  // История является частью поддерживаемой отмены/восстановления. Пока ссылка
  // присутствует хотя бы в одном снимке, оригинал не является бесхозным.
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='history'",
      )
      .get()
  )
    for (const row of db.prepare("SELECT data FROM history").all()) {
      const matches = String(row.data).matchAll(
        /\/media\/([a-zA-Z0-9-]+\.(?:jpg|png|webp|gif))/g,
      );
      for (const match of matches) result.add(match[1]);
    }
  if (includeBackups) {
    const file = String(
      db
        .prepare("PRAGMA database_list")
        .all()
        .find((row) => row.name === "main")?.file || "",
    );
    if (file) {
      const backups = join(dirname(file), "backups");
      for (const name of (() => {
        try {
          return readdirSync(backups);
        } catch {
          return [];
        }
      })()) {
        if (!name.endsWith(".sqlite")) continue;
        let backup: DatabaseSync | undefined;
        try {
          backup = new DatabaseSync(join(backups, name), { readOnly: true });
          for (const media of referencedMedia(backup, false)) result.add(media);
        } catch {
          // Повреждённая копия не должна останавливать GC остальных файлов.
        } finally {
          backup?.close();
        }
      }
    }
  }
  return result;
}

export function pruneOrphanMedia(
  db: DatabaseSync,
  directory: string,
  {
    now = Date.now(),
    graceMs = DEFAULT_GRACE_MS,
  }: { now?: number; graceMs?: number } = {},
) {
  const referenced = referencedMedia(db),
    removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!fileNamePattern.test(name) || referenced.has(name)) continue;
    const path = resolve(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || now - stat.mtimeMs < graceMs) continue;
      unlinkSync(path);
      removed.push(name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  return removed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const databasePath = process.argv[2],
    uploads = process.argv[3];
  if (!databasePath || !uploads) {
    console.error("Usage: media-gc.ts <database.sqlite> <uploads-directory>");
    process.exitCode = 2;
  } else if (configuredDatabaseBackend(databasePath) === "postgres") {
    // Native PostgreSQL backups and multiple archives share the upload directory.
    // A single archive's RLS-filtered references cannot prove a file is unused.
    // Retain originals until GC can account for every archive and backup.
    console.log(
      "Media GC: PostgreSQL originals retained (cross-archive/backup retention)",
    );
  } else {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const removed = pruneOrphanMedia(db, uploads);
      console.log(`Media GC: removed ${removed.length} orphan file(s)`);
    } finally {
      db.close();
    }
  }
}
