import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { archiveDeletionDirectory } from "./archive-deletion-files.ts";
import type { StoreDatabase } from "./store-database.ts";

const retentionMs = 24 * 60 * 60_000;
const archiveName = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const generatedTemporary = /^\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export type AiOrphanSweepResult = { removed: number; errors: number };

async function entries(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  });
}

async function oldChatDirectory(path: string, cutoff: number, generated: boolean) {
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error(`Unsafe AI file directory: ${path}`);
  if (directory.mtimeMs > cutoff) return false;
  for (const file of await entries(path)) {
    if (!(uuid.test(file.name) || (generated && generatedTemporary.test(file.name))))
      throw new Error(`Unexpected AI file name: ${join(path, file.name)}`);
    const info = await lstat(join(path, file.name));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Unsafe AI file entry: ${join(path, file.name)}`);
    if (info.mtimeMs > cutoff) return false;
  }
  return true;
}

/** Host-level maintenance: no archive HTTP route or recursive HTTP cleanup is needed. */
export async function sweepPlatformAiOrphans(
  db: StoreDatabase,
  databasePath: string,
  options: {
    now?: number;
    onError?: (archiveId: string, error: unknown) => void;
  } = {},
): Promise<AiOrphanSweepResult> {
  if (db.kind !== "postgres" || !db.postgresTransaction || !db.withExclusivePlatformTask)
    return { removed: 0, errors: 0 };
  const cutoff = (options.now ?? Date.now()) - retentionMs;
  const result = { removed: 0, errors: 0 };
  const report = (archiveId: string, error: unknown) => {
    result.errors++;
    if (options.onError) options.onError(archiveId, error);
    else console.error("ai_orphan_sweep_failed", archiveId, error);
  };
  const root = resolve(dirname(databasePath), "archives");
  return db.withExclusivePlatformTask("ai-orphan-sweep", async () => {
    let archives: Dirent[];
    try {
      const rootInfo = await lstat(root).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!rootInfo) return result;
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error(`Unsafe archive root: ${root}`);
      archives = await entries(root);
    }
    catch (error) { report("platform", error); return result; }
    for (const archive of archives) {
      if (!archiveName.test(archive.name)) continue;
      const archiveId = archive.name;
      try {
        if (!archive.isDirectory() || archive.isSymbolicLink())
          throw new Error(`Unsafe archive directory: ${archiveId}`);
        const { directory } = archiveDeletionDirectory(databasePath, archiveId);
        const physical = await lstat(directory);
        if (!physical.isDirectory() || physical.isSymbolicLink())
          throw new Error(`Unsafe archive directory: ${archiveId}`);
        const live = await db.postgresTransaction!(async (client) => {
          await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
          const archiveRow = await client.query("SELECT 1 FROM archives WHERE id=$1", [archiveId]);
          if (!archiveRow.rowCount) return null;
          const chats = await client.query<{ id: string }>(
            "SELECT id FROM ai_chats WHERE archive_id=$1", [archiveId]);
          return new Set(chats.rows.map((row) => row.id.toLowerCase()));
        });
        // A deleted archive is owned by the separate marked-directory cleanup.
        if (!live) continue;
        for (const [relativeRoot, generated] of [
          [join("uploads", "ai-chat-files"), false],
          ["ai-generated-files", true],
        ] as const) {
          const scan = async () => {
            if (!generated) {
              const uploads = await lstat(join(directory, "uploads")).catch((error: unknown) => {
                if (missing(error)) return null;
                throw error;
              });
              if (!uploads) return;
              if (!uploads.isDirectory() || uploads.isSymbolicLink())
                throw new Error(`Unsafe archive uploads: ${archiveId}`);
            }
            const fileRoot = join(directory, relativeRoot);
            const rootInfo = await lstat(fileRoot).catch((error: unknown) => {
              if (missing(error)) return null;
              throw error;
            });
            if (!rootInfo) return;
            if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
              throw new Error(`Unsafe AI file root: ${fileRoot}`);
            for (const chat of await entries(fileRoot)) {
              if (!uuid.test(chat.name)) continue;
              try {
                if (!chat.isDirectory() || chat.isSymbolicLink())
                  throw new Error(`Unsafe AI chat directory: ${chat.name}`);
                if (live.has(chat.name.toLowerCase())) continue;
                const chatPath = join(fileRoot, chat.name);
                if (!(await oldChatDirectory(chatPath, cutoff, generated))) continue;
                await rm(chatPath, { recursive: true, force: true });
                result.removed++;
              } catch (error) {
                if (!missing(error)) report(archiveId, error);
              }
            }
          };
          try {
            if (generated)
              await db.withExclusivePlatformTask!("ai-generated-files", scan);
            else await scan();
          } catch (error) { report(archiveId, error); }
        }
      } catch (error) { report(archiveId, error); }
    }
    return result;
  });
}
