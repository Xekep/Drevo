import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { StoreDatabase } from "./store-database.ts";

const marker = ".drevo-delete-pending";
const archiveName = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Only an archive's own directory below data/archives may be removed. */
export function archiveDeletionDirectory(
  databasePath: string,
  archiveId: string,
) {
  if (!archiveName.test(archiveId)) throw new Error("Некорректный архив");
  const root = resolve(dirname(databasePath), "archives");
  const directory = resolve(root, archiveId);
  if (relative(root, directory) !== archiveId)
    throw new Error("Каталог архива вне хранилища");
  return { root, directory };
}

export async function markArchiveForDeletion(
  directory: string,
  archiveId: string,
) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Каталог архива изменён");
  const path = join(directory, marker);
  const existing = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      (await readFile(path, "utf8")) !== archiveId
    )
      throw new Error("Отметка удаления архива изменена");
    return;
  }
  await writeFile(path, archiveId, { flag: "wx" });
}

export async function removeDeletedArchiveFiles(
  databasePath: string,
  archiveId: string,
) {
  const { directory } = archiveDeletionDirectory(databasePath, archiveId);
  const info = await lstat(directory).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Каталог архива изменён");
  if ((await readFile(join(directory, marker), "utf8")) !== archiveId)
    throw new Error("Нет отметки удаления архива");
  await rm(directory, { recursive: true, force: true });
}

/** Retry filesystem cleanup after a crash between DB commit and unlink. */
export async function cleanupDeletedArchiveDirectories(
  db: StoreDatabase,
  databasePath: string,
) {
  if (db.kind !== "postgres") return;
  const root = resolve(dirname(databasePath), "archives");
  for (const entry of await readdir(root, {
    withFileTypes: true,
    encoding: "utf8",
  }).catch((error: unknown) => {
    if (missing(error)) return [] as Dirent[];
    throw error;
  })) {
    if (!entry.isDirectory() || !archiveName.test(entry.name)) continue;
    const { directory } = archiveDeletionDirectory(databasePath, entry.name);
    if (
      (await readFile(join(directory, marker), "utf8").catch(() => "")) !==
      entry.name
    )
      continue;
    const exists = await db.transaction(async () => {
      await db
        .prepare("", "SELECT set_config('drevo.archive_id',?,true)")
        .get(entry.name);
      return !!(await db
        .prepare("", "SELECT 1 FROM archives WHERE id=?")
        .get(entry.name));
    }, true);
    if (!exists)
      await removeDeletedArchiveFiles(databasePath, entry.name).catch(
        (error) => {
          console.error("archive_file_cleanup_failed", entry.name, error);
        },
      );
  }
}
