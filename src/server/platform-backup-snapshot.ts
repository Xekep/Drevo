import pg from "pg";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFile, lstat, link, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { backupProcess } from "./backup-process.ts";
import { writeDatabaseBackup } from "./backup.ts";
import { stageTreeBackupFiles } from "./tree-backup-files.ts";
import { runtimeReleaseId } from "./runtime-release.ts";

const safeArchive = /^[a-zA-Z0-9_-]{1,128}$/;
export function assertPlatformBackupRole(role: { rolsuper: boolean; rolbypassrls: boolean }) {
  if (!role.rolsuper && !role.rolbypassrls)
    throw new Error("Оператор полной копии должен обходить RLS. Runtime-роль приложения не подходит");
}

async function stageDirectory(source: string, target: string, signal: AbortSignal, optional = false) {
  let info;
  try { info = await lstat(source); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isDirectory()) throw new Error("Каталог оригиналов должен быть обычным каталогом");
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (entry.name.startsWith(".")) continue; // Regenerable previews and upload staging.
    const from = join(source, entry.name), to = join(target, entry.name);
    const current = await lstat(from);
    if (current.isDirectory()) await stageDirectory(from, to, signal);
    else if (current.isFile()) await link(from, to);
    else throw new Error("Символические ссылки в оригиналах не допускаются");
  }
}

async function copyPrivateKey(source: string, target: string, required = false) {
  let info;
  try { info = await lstat(source); }
  catch (error) { if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077)))
    throw new Error("Ключ шифрования должен быть приватным обычным файлом");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
}

/** Immutable originals are pinned by inode. We validate references from the
 * same exported PG snapshot used by pg_dump, not from a later live query. */
export async function platformBackupSnapshot(databasePath: string, primaryId: string,
  stage: string, signal: AbortSignal) {
  const root = dirname(databasePath), shared = join(stage, "shared");
  await mkdir(shared, { recursive: true, mode: 0o700 });
  const backend = process.env.DATABASE_BACKEND || "sqlite";
  const directoryFor = (id: string) => {
    if (!safeArchive.test(id)) throw new Error("Некорректный идентификатор архива");
    return id === primaryId ? "" : "archives/" + id;
  };
  const pinArchive = async (id: string) => {
    const prefix = directoryFor(id);
    await stageDirectory(join(root, prefix, "uploads"), join(shared, prefix, "uploads"), signal, true);
    await stageDirectory(join(root, prefix, "ai-generated-files"), join(shared, prefix, "ai-generated-files"), signal, true);
    await copyPrivateKey(join(root, prefix, basename(databasePath) + ".secrets.key"),
      join(shared, prefix, basename(databasePath) + ".secrets.key"));
  };
  let archives: string[] = [primaryId], snapshot = "", serverVersion: string | null = null;
  if (backend === "postgres") {
    if (!process.env.PLATFORM_BACKUP_PGUSER)
      throw new Error("Отдельный оператор PostgreSQL для полной копии не настроен");
    const client = new pg.Client({ connectionTimeoutMillis: 5000,
      user: process.env.PLATFORM_BACKUP_PGUSER,
      host: process.env.PLATFORM_BACKUP_PGHOST || process.env.PGHOST,
      port: Number(process.env.PLATFORM_BACKUP_PGPORT || process.env.PGPORT || 5432),
      password: process.env.PLATFORM_BACKUP_PGPASSWORD,
      options: "-c search_path=public -c timezone=UTC", application_name: "drevo_platform_backup" });
    await client.connect();
    try {
      const capability = await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      assertPlatformBackupRole(capability.rows[0]);
      serverVersion = (await client.query("SHOW server_version")).rows[0].server_version;
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL row_security=off");
      await client.query("SET LOCAL statement_timeout='60s'");
      snapshot = (await client.query("SELECT pg_export_snapshot() AS id")).rows[0].id;
      archives = (await client.query("SELECT id FROM archives ORDER BY id")).rows.map((row) => String(row.id));
      if (!archives.includes(primaryId)) throw new Error("Основной архив отсутствует в снимке платформы");
      for (const id of archives) await pinArchive(id);
      const inventory = await readFile(new URL("../../ops/postgres/media-filesystem-refs.sql", import.meta.url), "utf8");
      const sql = inventory.slice(inventory.indexOf("WITH live_restores"), inventory.lastIndexOf("COMMIT;"));
      await client.query("DECLARE backup_media CURSOR FOR " + sql);
      while (true) {
        const chunk = await client.query("FETCH FORWARD 500 FROM backup_media");
        if (!chunk.rowCount) break;
        for (const row of chunk.rows) {
          const ref = JSON.parse(String(Object.values(row)[0])) as { kind: string; archive_id: string; name?: string; known_bytes?: number };
          if (ref.kind !== "ref") continue;
          if (!ref.name || !/^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(ref.name))
            throw new Error("Недопустимый путь оригинала в базе");
          const info = await lstat(join(shared, directoryFor(ref.archive_id), "uploads", ref.name));
          if (!info.isFile() || (ref.known_bytes != null && info.size !== Number(ref.known_bytes)))
            throw new Error("Оригинал из снимка базы отсутствует или изменился");
        }
      }
      await client.query("CLOSE backup_media");
      // Comment originals have no /media URL; account/chat IDs remain in native PG.
      await client.query("DECLARE backup_comments CURSOR FOR SELECT archive_id,attachments FROM person_comments");
      while (true) {
        const chunk = await client.query("FETCH FORWARD 500 FROM backup_comments");
        if (!chunk.rowCount) break;
        for (const row of chunk.rows)
          for (const file of (typeof row.attachments === "string" ? JSON.parse(row.attachments) : row.attachments) as { id: string; size: number }[]) {
            if (!/^[a-f0-9-]{36}$/.test(file.id)) throw new Error("Некорректное вложение обсуждения");
            const info = await lstat(join(shared, directoryFor(row.archive_id), "uploads/discussion-files", file.id));
            if (!info.isFile() || info.size !== file.size) throw new Error("Вложение обсуждения отсутствует");
          }
      }
      await client.query("CLOSE backup_comments");
      await client.query("DECLARE backup_chat_files CURSOR FOR SELECT archive_id,data FROM ai_chat_messages");
      while (true) {
        const chunk = await client.query("FETCH FORWARD 500 FROM backup_chat_files");
        if (!chunk.rowCount) break;
        for (const row of chunk.rows)
          for (const file of row.data.attachments || []) {
            const match = /^\/api\/ai\/attachments\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(file.url);
            if (!match) throw new Error("Некорректный путь вложения ИИ");
            const info = await lstat(join(shared, directoryFor(row.archive_id), "uploads/ai-chat-files", match[1], match[2]));
            if (!info.isFile() || info.size !== file.size) throw new Error("Вложение диалога ИИ отсутствует");
          }
      }
      await client.query("CLOSE backup_chat_files");
      const keyed = await client.query("SELECT archive_id FROM ai_settings WHERE api_key_ciphertext<>''");
      for (const row of keyed.rows)
        if ((await lstat(join(shared, directoryFor(row.archive_id), basename(databasePath) + ".secrets.key"))).size !== 32)
          throw new Error("Ключ настроек ИИ не сохранён");
      const cleanupKey = (await client.query("SELECT fingerprint FROM platform_ai_cleanup_keys WHERE version=1")).rows[0];
      for (const name of ["ai-provider-cleanup.v1.key", "backups/platform-keys/ai-provider-cleanup.v1.key"])
        await copyPrivateKey(join(root, name), join(shared, name));
      if (cleanupKey) {
        let matched: Buffer | undefined;
        for (const name of ["ai-provider-cleanup.v1.key", "backups/platform-keys/ai-provider-cleanup.v1.key"]) {
          try {
            const bytes = await readFile(join(shared, name));
            const value = JSON.parse(bytes.toString("utf8"));
            const key = Buffer.from(value.key || "", "base64");
            if (value.version === 1 && key.length === 32 &&
                createHash("sha256").update(key).digest("hex") === cleanupKey.fingerprint) matched = bytes;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (!matched) throw new Error("Ключ очистки провайдера не соответствует снимку базы");
        await writeFile(join(shared, "ai-provider-cleanup.v1.key"), matched, { mode: 0o600 });
        await mkdir(join(shared, "backups/platform-keys"), { recursive: true, mode: 0o700 });
        await writeFile(join(shared, "backups/platform-keys/ai-provider-cleanup.v1.key"), matched, { mode: 0o600 });
      }
      await backupProcess("pg_dump", ["--format=custom", "--snapshot=" + snapshot,
        "--file=" + join(stage, "platform.pgdump")], signal);
      await backupProcess("pg_restore", ["--list", join(stage, "platform.pgdump")], signal);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  } else {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try { await writeDatabaseBackup(source, join(stage, "platform.sqlite")); }
    finally { source.close(); }
    await pinArchive(primaryId);
    // Verify every family/document/comment original; do not mistake a file copy for a valid DB backup.
    await stageTreeBackupFiles(join(stage, "platform.sqlite"), root, join(stage, ".verify-originals"));
    for (const name of ["ai-provider-cleanup.v1.key", "backups/platform-keys/ai-provider-cleanup.v1.key"])
      await copyPrivateKey(join(root, name), join(shared, name));
  }
  await writeFile(join(stage, "platform-manifest.json"), JSON.stringify({
    format: "drevo-platform", version: 1, backend, primaryArchiveId: primaryId, serverVersion,
    releaseId: runtimeReleaseId, gitCommit: runtimeReleaseId?.split("-")[0] || null,
    archiveIds: archives, databaseName: process.env.PGDATABASE || null,
    databaseFile: backend === "postgres" ? "platform.pgdump" : "platform.sqlite",
    configuredDatabaseFile: basename(databasePath), createdAt: new Date().toISOString(),
    sharedDirectory: "shared", restoreMode: "offline",
  }, null, 2), { mode: 0o600 });
}
