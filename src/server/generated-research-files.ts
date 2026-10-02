import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { aiChatStore } from "./ai-chats.ts";
import type { GeneratedResearchFile } from "./code-interpreter.ts";
import { reservePlatformDisk } from "./platform-disk-reservation.ts";
import type { StoreDatabase } from "./store-database.ts";

const MAX_GENERATED_FILES_BYTES = 64 * 1024 * 1024;
const FILE_RETENTION_MS = 60 * 60_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type GeneratedResearchFileMeta = {
  name: string;
  url: string;
  contentType: string;
  size: number;
  expires: number;
};

export function pruneGeneratedResearchFiles(
  files: Map<string, GeneratedResearchFile>,
  now = Date.now(),
) {
  for (const [id, current] of files)
    if (current.expires <= now) files.delete(id);
}

/** All generated files share one bounded, process-local download cache. */
export function storeGeneratedResearchFile(
  files: Map<string, GeneratedResearchFile>,
  file: GeneratedResearchFile,
  now = Date.now(),
  maxBytes = MAX_GENERATED_FILES_BYTES,
) {
  pruneGeneratedResearchFiles(files, now);
  let used = 0;
  for (const current of files.values()) used += current.bytes.length;
  if (used + file.bytes.length > maxBytes) return null;
  const id = randomUUID();
  files.set(id, file);
  return id;
}

/** PostgreSQL backends on one host share temporary bytes; chat messages own the metadata. */
export function generatedResearchFileStore(
  db: StoreDatabase,
  uploadsDirectory: string,
  chats: ReturnType<typeof aiChatStore>,
  beforeInstall?: () => Promise<void>,
) {
  const files = new Map<string, GeneratedResearchFile>();
  const shared = db.kind === "postgres";
  const archiveDirectory = dirname(uploadsDirectory);
  const root = join(archiveDirectory, "ai-generated-files");
  const archiveParent = dirname(archiveDirectory);
  const platformDirectory = basename(archiveParent) === "archives" &&
    basename(archiveDirectory) === db.archiveId
    ? dirname(archiveParent) : archiveDirectory;
  const withPhysicalLock = <T>(work: () => Promise<T>) => {
    if (!db.withExclusivePlatformTask) throw new Error("Platform file lock unavailable");
    return db.withExclusivePlatformTask("ai-generated-files", work);
  };
  async function filesystemEntry(path: string) {
    try { return await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function reclaimExpiredAndCountPhysicalBytes() {
    const roots = [join(platformDirectory, "ai-generated-files")];
    const archivesDirectory = join(platformDirectory, "archives");
    const archives = await filesystemEntry(archivesDirectory);
    if (archives) {
      if (!archives.isDirectory() || archives.isSymbolicLink())
        throw new Error("Unsafe archive directory");
      for (const entry of await readdir(archivesDirectory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Unsafe archive directory");
        if (entry.isDirectory())
          roots.push(join(archivesDirectory, entry.name, "ai-generated-files"));
      }
    }
    let used = 0;
    for (const generatedRoot of roots) {
      const rootEntry = await filesystemEntry(generatedRoot);
      if (!rootEntry) continue;
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
        (process.platform !== "win32" && (rootEntry.mode & 0o077)))
        throw new Error("Unsafe generated-file directory");
      for (const chat of await readdir(generatedRoot, { withFileTypes: true })) {
        const chatPath = join(generatedRoot, chat.name);
        const chatEntry = await filesystemEntry(chatPath);
        if (!chatEntry) continue;
        if (chatEntry.isSymbolicLink()) throw new Error("Unsafe generated-file entry");
        if (chatEntry.isFile()) { used += chatEntry.size; continue; }
        if (!chatEntry.isDirectory() ||
          (process.platform !== "win32" && (chatEntry.mode & 0o077)))
          throw new Error("Unsafe generated-file directory");
        for (const file of await readdir(chatPath)) {
          const path = join(chatPath, file);
          const entry = await filesystemEntry(path);
          if (!entry) continue;
          if (!entry.isFile() || entry.isSymbolicLink())
            throw new Error("Unsafe generated-file entry");
          if (uuid.test(chat.name) && (uuid.test(file) ||
            /^\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/i.test(file)) &&
            entry.mtimeMs < Date.now() - FILE_RETENTION_MS) {
            await rm(path, { force: true });
            continue;
          }
          used += entry.size;
        }
      }
    }
    return used;
  }
  const folder = (chatId: string) => {
    if (!uuid.test(chatId)) throw new Error("Invalid chat ID");
    return join(root, chatId);
  };
  async function regularDirectory(path: string) {
    const entry = await lstat(path).catch(() => null);
    return entry?.isDirectory() && !entry.isSymbolicLink() &&
      (process.platform === "win32" || (entry.mode & 0o077) === 0);
  }
  async function prepareFolder(chatId: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await regularDirectory(root))) throw new Error("Unsafe generated-file directory");
    const path = folder(chatId);
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await regularDirectory(path))) throw new Error("Unsafe generated-file directory");
    return path;
  }
  return {
    async save(file: GeneratedResearchFile) {
      const id = storeGeneratedResearchFile(files, file);
      if (!id) return null;
      const url = shared
        ? `/api/ai/files/${file.chatId}/${id}`
        : `/api/ai/files/${id}`;
      if (shared) {
        const saved = await withPhysicalLock(async () => {
          let reservation: Awaited<ReturnType<typeof reservePlatformDisk>> | undefined;
          let staged = "";
          let installed = "";
          let renamed = false;
          try {
            const path = await prepareFolder(file.chatId);
            if ((await reclaimExpiredAndCountPhysicalBytes()) + file.bytes.length > MAX_GENERATED_FILES_BYTES)
              return false;
            if (file.bytes.length)
              reservation = await reservePlatformDisk(db, file.bytes.length, async () => {
                const space = await statfs(root);
                return space.bavail * space.bsize;
              });
            staged = join(path, `.${id}.${randomUUID()}.tmp`);
            installed = join(path, id);
            const handle = await open(staged, "wx", 0o600);
            try {
              await handle.writeFile(file.bytes);
            } finally {
              await handle.close();
            }
            await reservation?.assertValid();
            await beforeInstall?.();
            await rename(staged, installed);
            renamed = true;
          } catch (error) {
            files.delete(id);
            if (staged) await rm(staged, { force: true }).catch(() => {});
            if (renamed) await rm(installed, { force: true }).catch(() => {});
            throw error;
          } finally {
            await reservation?.release();
          }
          return true;
        }).catch((error) => { files.delete(id); throw error; });
        if (!saved) { files.delete(id); return null; }
      }
      return { name: file.name, url };
    },
    metadata(links: Array<{ name: string; url: string }>): GeneratedResearchFileMeta[] {
      return links.flatMap((link) => {
        const id = link.url.split("/").at(-1) || "";
        const file = files.get(id);
        return file && file.name === link.name
          ? [{ name: file.name, url: link.url, contentType: file.contentType,
            size: file.bytes.length, expires: file.expires }]
          : [];
      });
    },
    local(id: string) { return uuid.test(id) ? files.get(id) : undefined; },
    async read(chatId: string, id: string, meta: GeneratedResearchFileMeta) {
      if (!shared || !uuid.test(id) || meta.url !== `/api/ai/files/${chatId}/${id}` ||
        typeof meta.name !== "string" || !meta.name || meta.name.length > 255 ||
        [...meta.name].some((character) => character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127) ||
        !Number.isSafeInteger(meta.size) || meta.size < 0 ||
        meta.size > MAX_GENERATED_FILES_BYTES || !Number.isSafeInteger(meta.expires) ||
        meta.expires < Date.now() || !/^[\w.+-]+\/[\w.+-]+$/.test(meta.contentType))
        return null;
      const path = folder(chatId);
      if (!(await regularDirectory(root)) || !(await regularDirectory(path))) return null;
      let handle;
      try {
        handle = await open(join(path, id), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== meta.size) return null;
        const bytes = await handle.readFile();
        return bytes.length === meta.size ? bytes : null;
      } catch (error) {
        if (["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || ""))
          return null;
        throw error;
      } finally {
        await handle?.close();
      }
    },
    async deleteChat(chatId: string) {
      if (!uuid.test(chatId)) return;
      for (const [id, file] of files)
        if (file.chatId === chatId) files.delete(id);
      if (shared) await withPhysicalLock(async () => {
        if (await regularDirectory(root) && await regularDirectory(folder(chatId)))
          await rm(folder(chatId), { recursive: true, force: true });
      });
    },
    async prune(now = Date.now()) {
      pruneGeneratedResearchFiles(files, now);
      if (!shared) return;
      await withPhysicalLock(async () => {
        if (!(await regularDirectory(root))) return;
        const liveChats = await chats.allIds();
        for (const chat of await readdir(root, { withFileTypes: true })) {
          if (!uuid.test(chat.name) || !chat.isDirectory() || chat.isSymbolicLink()) continue;
          const path = folder(chat.name);
          if (!(await regularDirectory(path))) continue;
          if (!liveChats.has(chat.name)) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
          for (const item of await readdir(path, { withFileTypes: true }).catch(() => [])) {
            if ((!uuid.test(item.name) && !/^\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/i.test(item.name)) ||
              !item.isFile() || item.isSymbolicLink()) continue;
            const current = await lstat(join(path, item.name)).catch(() => null);
            if (current && current.mtimeMs < now - FILE_RETENTION_MS)
              await rm(join(path, item.name), { force: true });
          }
          await rmdir(path).catch(() => {});
        }
      });
    },
    close() { files.clear(); },
  };
}
