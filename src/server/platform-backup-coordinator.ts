import { createReadStream } from "node:fs";
import { chmod, lstat, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreDatabase } from "./store-database.ts";
import type { BackupJob, BackupRecord, BackupSettings, BackupStatus } from "../shared/backup-management.ts";
import { BackupBusyError } from "./backup-coordinator.ts";
import { backupStore, BackupInputError, validateBackupSettings } from "./backup-store.ts";
import { backupProcess } from "./backup-process.ts";
import { backupRemote, type BackupRemote } from "./backup-remote.ts";

export class PlatformBackupUnavailable extends Error {}
type State = { settings: BackupSettings; next: number; records: BackupRecord[];
  job: BackupJob | null; lease: number };
const pattern = /^platform-\d{8}T\d{6}Z-[a-f0-9-]{36}\.tar\.gz$/;
async function checksum(file: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(file, { signal })) hash.update(block);
  return hash.digest("hex");
}

/** One platform-wide job and catalog, outside the archive RLS namespace. */
export async function platformBackupCoordinator(db: StoreDatabase, databasePath: string,
  options: { schedule?: boolean; remote?: BackupRemote; now?: () => number } = {}) {
  const root = dirname(databasePath), directory = join(root, "platform-backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = join(directory, "catalog.json"), now = options.now || Date.now;
  const remote = options.remote || backupRemote(root);
  const controller = new AbortController(), signal = controller.signal;
  let pending: Promise<void> | undefined, closed = false;
  const withLock = <T>(work: () => Promise<T>) => db.withExclusivePlatformTask
    ? db.withExclusivePlatformTask("platform-backups", work) : work();
  async function read(): Promise<State> {
    const info = await lstat(statePath);
    if (!info.isFile()) throw new BackupInputError("Каталог резервных копий повреждён");
    return JSON.parse(await readFile(statePath, "utf8")) as State;
  }
  async function write(state: State) {
    const temp = join(directory, ".catalog-" + randomUUID());
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, statePath);
    } finally { await rm(temp, { force: true }); }
  }
  await withLock(async () => {
    try { await read(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const existing = await (await backupStore(db)).settings();
      await write({ settings: existing.value, next: existing.next, records: [], job: null, lease: 0 });
    }
  });
  const configured = () => db.kind !== "postgres" || !!process.env.PLATFORM_BACKUP_PGUSER;
  async function status(_actor?: string, offset = 0): Promise<BackupStatus> {
    const state = await read();
    const job = state.job?.state === "running" && state.lease < now()
      ? { ...state.job, state: "failed" as const, error: "Работа прервана. Создайте копию повторно." } : state.job;
    return { settings: state.settings, nextRunAt: configured() && state.settings.enabled
      ? new Date(state.next).toISOString() : null, localDirectory: directory,
      sshConfig: remote.config, total: state.records.length,
      records: state.records.slice(offset, offset + 20), job,
      available: configured(), unavailableReason: configured() ? undefined :
        "Для полной копии PostgreSQL настройте отдельного оператора резервирования на сервере." };
  }
  async function remove(item: BackupRecord) {
    if (!pattern.test(item.name)) throw new BackupInputError("Недопустимое имя копии платформы");
    if (item.storage === "remote") await remote.remove(item, signal);
    else {
      await rm(join(directory, item.name), { force: true });
      await rm(join(directory, item.name + ".sha256"), { force: true });
    }
  }
  async function create(config: BackupSettings): Promise<BackupRecord> {
    const stage = await mkdtemp(join(directory, ".platform-"));
    const id = randomUUID(), stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const name = "platform-" + stamp + "-" + id + ".tar.gz", file = join(stage, name);
    try {
      await chmod(stage, 0o700);
      const estimatedDatabaseBytes = db.kind === "postgres"
        ? Number((await db.prepare("", "SELECT pg_database_size(current_database()) AS bytes").get())!.bytes)
        : (await lstat(databasePath)).size;
      const initialDisk = await statfs(directory);
      if (initialDisk.bavail * initialDisk.bsize < estimatedDatabaseBytes + 256 * 1024 ** 2)
        throw new BackupInputError("Недостаточно места для снимка базы платформы. Старые копии сохранены.");
      await backupProcess(process.execPath, ["--experimental-strip-types",
        fileURLToPath(new URL("./platform-backup-worker.mjs", import.meta.url)),
        databasePath, db.archiveId || "legacy", stage], signal);
      await writeFile(join(stage, "backup-settings.json"), JSON.stringify(config), { mode: 0o600 });
      let bytes = 0;
      const measure = async (path: string) => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const current = join(path, entry.name);
          if (entry.isDirectory()) await measure(current);
          else if (entry.isFile()) bytes += (await lstat(current)).size;
        }
      };
      await measure(stage);
      const disk = await statfs(directory);
      if (disk.bavail * disk.bsize < bytes + 256 * 1024 ** 2)
        throw new BackupInputError("Недостаточно места для полной копии. Старые копии сохранены.");
      await backupProcess("tar", ["-czf", file, "-C", stage,
        "platform-manifest.json", "backup-settings.json",
        db.kind === "postgres" ? "platform.pgdump" : "platform.sqlite", "shared"], signal);
      await chmod(file, 0o600);
      const item: BackupRecord = { id, name, createdAt: new Date(now()).toISOString(),
        size: (await lstat(file)).size, sha256: await checksum(file, signal), storage: config.storage,
        remoteHost: config.storage === "remote" ? config.remoteHost : "",
        remoteDirectory: config.storage === "remote" ? config.remoteDirectory : "" };
      if (config.storage === "remote") await remote.upload(config, name, file, item.sha256, signal);
      else {
        await rename(file, join(directory, name));
        await writeFile(join(directory, name + ".sha256"), item.sha256 + "  " + name + "\n", { mode: 0o600 });
      }
      return item;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  async function launch(kind: "create" | "check", config?: BackupSettings, scheduled = false) {
    if (closed || pending) throw new BackupBusyError("Уже выполняется операция с копиями платформы.");
    if (kind === "create" && !configured()) throw new PlatformBackupUnavailable("Оператор полной копии PostgreSQL не настроен.");
    let accept!: (value: BackupJob | null) => void, deny!: (error: unknown) => void;
    const claimed = new Promise<BackupJob | null>((resolve, reject) => { accept = resolve; deny = reject; });
    pending = withLock(async () => {
      const state = await read();
      if (state.job?.state === "running" && state.lease > now()) throw new BackupBusyError("Копия платформы уже создаётся.");
      if (scheduled && (!state.settings.enabled || state.next > now())) { accept(null); return; }
      const job: BackupJob = { id: randomUUID(), kind, state: "running", startedAt: new Date(now()).toISOString() };
      state.job = job; state.lease = now() + 90_000;
      if (kind === "create") state.next = now() + state.settings.intervalHours * 3600000;
      await write(state); accept(job);
      let persistence = Promise.resolve();
      const heartbeat = setInterval(() => {
        state.lease = now() + 90_000;
        persistence = persistence.then(() => write(state)).catch(() => controller.abort());
      }, 15_000);
      heartbeat.unref();
      try {
        if (kind === "check") await remote.check(config!, signal);
        else {
          const item = await create(state.settings);
          state.records.unshift(item);
          await write(state);
          const matching = state.records.filter((r) => r.storage === item.storage &&
            (r.storage === "local" || (r.remoteHost === item.remoteHost && r.remoteDirectory === item.remoteDirectory)));
          for (const obsolete of matching.slice(state.settings.keepCount)) {
            try { await remove(obsolete); state.records = state.records.filter((r) => r.id !== obsolete.id); }
            catch { job.warning = "Копия создана; часть старых копий не удалось удалить."; }
          }
        }
        job.state = "succeeded";
      } catch {
        job.state = "failed";
        job.error = "Полная копия не создана. Проверьте оператора PostgreSQL, обязательные оригиналы, ключи и место на диске.";
        state.next = now() + 3600000;
        console.error(JSON.stringify({ event: "platform_backup_failed", jobId: job.id, kind }));
      } finally {
        clearInterval(heartbeat); await persistence;
        state.lease = 0; await write(state);
      }
    }).catch((error) => { deny(error); }).finally(() => { pending = undefined; });
    return await claimed;
  }
  async function save(value: unknown) {
    const config = validateBackupSettings(value);
    if (pending) throw new BackupBusyError("Дождитесь завершения копии платформы.");
    return withLock(async () => {
      const state = await read();
      if (state.settings.enabled !== config.enabled || state.settings.intervalHours !== config.intervalHours)
        state.next = now() + config.intervalHours * 3600000;
      state.settings = config; await write(state); return config;
    });
  }
  async function withFile<T>(id: string, consume: (path: string, record: BackupRecord) => Promise<T>) {
    const item = (await read()).records.find((r) => r.id === id);
    if (!item || !pattern.test(item.name)) throw new BackupInputError("Копия платформы не найдена");
    const folder = await mkdtemp(join(directory, ".download-")), file = join(folder, item.name);
    try {
      if (item.storage === "local") await link(join(directory, item.name), file);
      else {
        const disk = await statfs(directory);
        if (disk.bavail * disk.bsize < item.size + 256 * 1024 ** 2) throw new BackupInputError("Недостаточно места для скачивания");
        await remote.download(item, file, signal); await chmod(file, 0o600);
      }
      const info = await lstat(file);
      if (!info.isFile() || info.size !== item.size || await checksum(file, signal) !== item.sha256)
        throw new BackupInputError("Контрольная сумма полной копии не совпадает");
      return await consume(file, item);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
  async function tick() {
    if (closed || pending || !configured()) return;
    try { await launch("create", undefined, true); }
    catch { /* Another process owns the global lock; its catalog contains the outcome. */ }
  }
  const timer = options.schedule === false ? null : setInterval(() => void tick(), 30_000);
  timer?.unref();
  return { status, save, withFile, startCreate: () => launch("create"),
    check: (value: unknown) => launch("check", validateBackupSettings(value)), tick,
    idle: async () => { await pending; },
    close: async () => { closed = true; if (timer) clearInterval(timer); controller.abort(); await pending; } };
}
export type PlatformBackupCoordinator = Awaited<ReturnType<typeof platformBackupCoordinator>>;
