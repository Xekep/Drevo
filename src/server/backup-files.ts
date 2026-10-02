import {
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BackupRecord,
  BackupSettings,
} from "../shared/backup-management.ts";
import { BackupInputError } from "./backup-store.ts";
import { backupProcess } from "./backup-process.ts";
import { backupRemote, type BackupRemote } from "./backup-remote.ts";
const hour = 3600000;
const filePattern = /^full-\d{8}T\d{6}Z(?:-[a-f0-9-]{36})?\.tar\.gz$/;
const maxSize = 12 * 1024 ** 3;
async function checksum(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(file, { signal }))
    hash.update(block);
  return hash.digest("hex");
}

export function backupFiles(
  databasePath: string,
  suppliedRemote?: BackupRemote,
  now = Date.now,
  databaseBytes = async () => (await stat(databasePath)).size,
  archiveId?: string,
) {
  const root = dirname(databasePath),
    directory = join(root, "backups");
  const remote = suppliedRemote || backupRemote(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function assertName(name: string) {
    if (!filePattern.test(name))
      throw new BackupInputError("Недопустимое имя резервной копии.");
  }
  function* existingCopies(): Generator<BackupRecord> {
    for (const name of readdirSync(directory)) {
      if (!filePattern.test(name)) continue;
      try {
        const info = lstatSync(join(directory, name));
        if (!info.isFile()) continue;
        const sha = readFileSync(
          join(directory, name + ".sha256"),
          "utf8",
        ).match(/^([a-f0-9]{64})\s/)?.[1];
        if (!sha) continue;
        yield {
          id: randomUUID(),
          name,
          createdAt: info.mtime.toISOString(),
          size: info.size,
          sha256: sha,
          storage: "local",
          remoteHost: "",
          remoteDirectory: "",
        };
      } catch {
        /* Incomplete copies and safety snapshots are not managed archives. */
      }
    }
  }
  async function create(config: BackupSettings, signal: AbortSignal) {
    const stage = await mkdtemp(join(directory, ".managed-"));
    const id = randomUUID(),
      stamp = new Date(now())
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    const name = "full-" + stamp + "-" + id + ".tar.gz",
      file = join(stage, name);
    try {
      await chmod(stage, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          !/^\.(managed|download)-[a-zA-Z0-9]{6}$/.test(entry.name)
        )
          continue;
        const abandoned = join(directory, entry.name);
        if (
          abandoned !== stage &&
          (await lstat(abandoned)).mtimeMs < now() - 48 * hour
        )
          await rm(abandoned, { recursive: true, force: true });
      }
      let needed = (await databaseBytes()) * 2;
      for (const entry of await readdir(join(root, "uploads"), {
        withFileTypes: true,
      })) {
        if (entry.isFile() && !entry.name.startsWith("."))
          needed += (await stat(join(root, "uploads", entry.name))).size;
      }
      const disk = await statfs(directory);
      if (disk.bavail * disk.bsize < needed + 256 * 1024 ** 2)
        throw new BackupInputError(
          "Недостаточно свободного места для полной копии. Старые копии не удалены.",
        );
      await backupProcess(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./backup-worker.mjs", import.meta.url)),
          databasePath,
          join(stage, "drevo.sqlite"),
          ...(archiveId ? [archiveId] : []),
        ],
        signal,
      );
      const files = ["drevo.sqlite"];
      try {
        const key = await lstat(databasePath + ".secrets.key");
        if (!key.isFile() || key.size !== 32)
          throw new BackupInputError(
            "Файл ключа шифрования повреждён: полная копия не создана.",
          );
        await copyFile(
          databasePath + ".secrets.key",
          join(stage, "drevo.sqlite.secrets.key"),
        );
        files.push("drevo.sqlite.secrets.key");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await backupProcess(
        "tar",
        [
          "--exclude=uploads/.*",
          "-czf",
          file,
          "-C",
          stage,
          ...files,
          "-C",
          root,
          "uploads",
        ],
        signal,
      );
      await chmod(file, 0o600);
      const size = (await stat(file)).size;
      if (size > maxSize)
        throw new BackupInputError(
          "Копия превышает лимит восстановления 12 ГиБ. Настройте внешнее системное резервирование.",
        );
      const sha256 = await checksum(file, signal),
        item: BackupRecord = {
          id,
          name,
          size,
          sha256,
          createdAt: new Date(now()).toISOString(),
          storage: config.storage,
          remoteHost: config.storage === "remote" ? config.remoteHost : "",
          remoteDirectory:
            config.storage === "remote" ? config.remoteDirectory : "",
        };
      if (config.storage === "remote")
        await remote.upload(config, name, file, sha256, signal);
      else {
        await writeFile(
          join(stage, name + ".sha256"),
          sha256 + "  " + name + "\n",
          { mode: 0o600 },
        );
        await rename(file, join(directory, name));
        await rename(
          join(stage, name + ".sha256"),
          join(directory, name + ".sha256"),
        );
      }
      return item;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  async function withFile<T>(
    item: BackupRecord,
    signal: AbortSignal,
    consume: (file: string, item: BackupRecord) => Promise<T>,
  ) {
    assertName(item.name);
    const temporary = await mkdtemp(join(directory, ".download-"));
    const file = join(temporary, item.name);
    try {
      await chmod(temporary, 0o700);
      if (item.storage === "remote") {
        const disk = await statfs(directory);
        if (disk.bavail * disk.bsize < item.size + 256 * 1024 ** 2)
          throw new BackupInputError(
            "Недостаточно места для скачивания и проверки копии.",
          );
        await remote.download(item, file, signal);
        await chmod(file, 0o600);
      } else {
        // Hold the inode while serving/verifying it even if another scheduler
        // prunes the catalog entry. Same filesystem; no second full-size copy.
        await link(join(directory, item.name), file);
      }
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.size !== item.size ||
        info.size > maxSize ||
        (await checksum(file, signal)) !== item.sha256
      )
        throw new BackupInputError(
          "Контрольная сумма или размер бэкапа не совпадают. Восстановление отменено.",
        );
      signal.throwIfAborted();
      return await consume(file, item);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  return {
    directory,
    sshConfig: remote.config,
    existingCopies,
    create,
    withFile,
    check: remote.check,
    async remove(item: BackupRecord, signal: AbortSignal) {
      assertName(item.name);
      if (item.storage === "remote") await remote.remove(item, signal);
      else {
        await rm(join(directory, item.name), { force: true });
        await rm(join(directory, item.name + ".sha256"), { force: true });
      }
    },
  };
}
