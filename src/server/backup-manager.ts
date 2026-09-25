import type { DatabaseSync } from "node:sqlite";
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
import type { ArchiveUser } from "../domain/access.ts";
import type {
  BackupJob,
  BackupRecord,
  BackupSettings,
  BackupStatus,
  RestorePreview,
} from "../shared/backup-management.ts";
import { auditStore } from "./audit.ts";
import { backupProcess } from "./backup-process.ts";
import { backupRemote, type BackupRemote } from "./backup-remote.ts";

const hour = 3600000;
const filePattern = /^full-\d{8}T\d{6}Z(?:-[a-f0-9-]{36})?\.tar\.gz$/;
const maxSize = 12 * 1024 ** 3;
const defaults: BackupSettings = {
  enabled: true,
  intervalHours: 24,
  keepCount: 30,
  storage: "local",
  remoteHost: "",
  remoteDirectory: "",
};

export class BackupBusyError extends Error {}
export class BackupInputError extends Error {}

export function validateBackupSettings(value: unknown): BackupSettings {
  const v = value as BackupSettings;
  if (
    !v ||
    typeof v.enabled !== "boolean" ||
    !Number.isInteger(v.intervalHours) ||
    v.intervalHours < 1 ||
    v.intervalHours > 720 ||
    !Number.isInteger(v.keepCount) ||
    v.keepCount < 1 ||
    v.keepCount > 365 ||
    !["local", "remote"].includes(v.storage) ||
    typeof v.remoteHost !== "string" ||
    typeof v.remoteDirectory !== "string"
  )
    throw new BackupInputError(
      "Укажите период от 1 до 720 часов и количество копий от 1 до 365.",
    );
  const host = v.remoteHost.trim(),
    path = v.remoteDirectory.trim().replace(/\/+$/, "");
  if (
    (host && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(host)) ||
    (path &&
      (!/^\/[a-zA-Z0-9_./-]{1,240}$/.test(path) ||
        path.split("/").some((p) => p === ".." || p === "."))) ||
    (v.storage === "remote" && (!host || !path))
  )
    throw new BackupInputError(
      "Укажите имя SSH-подключения и абсолютный каталог на отдельном сервере (без пробелов и ..).",
    );
  return {
    enabled: v.enabled,
    intervalHours: v.intervalHours,
    keepCount: v.keepCount,
    storage: v.storage,
    remoteHost: host,
    remoteDirectory: path,
  };
}

async function checksum(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(file, { signal }))
    hash.update(block);
  return hash.digest("hex");
}

export function backupManager(
  db: DatabaseSync,
  databasePath: string,
  options: {
    remote?: BackupRemote;
    now?: () => number;
    schedule?: boolean;
  } = {},
) {
  const now = options.now || Date.now,
    root = dirname(databasePath),
    directory = join(root, "backups");
  const remote = options.remote || backupRemote(root),
    audit = auditStore(db);
  let controller = new AbortController(),
    signal = controller.signal;
  let pending: Promise<void> | undefined,
    closed = false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  db.prepare("INSERT OR IGNORE INTO backup_settings VALUES(1,?,?)").run(
    JSON.stringify(defaults),
    now() + 24 * hour,
  );

  // Adopt previous daily full copies, never pre-deployment/before-import snapshots.
  for (const name of readdirSync(directory)) {
    if (
      !filePattern.test(name) ||
      db.prepare("SELECT 1 FROM backup_catalog WHERE name=?").get(name)
    )
      continue;
    try {
      const info = lstatSync(join(directory, name));
      if (!info.isFile()) continue;
      const sha = readFileSync(join(directory, name + ".sha256"), "utf8").match(
        /^([a-f0-9]{64})\s/,
      )?.[1];
      if (!sha) continue;
      const record: BackupRecord = {
        id: randomUUID(),
        name,
        createdAt: info.mtime.toISOString(),
        size: info.size,
        sha256: sha,
        storage: "local",
        remoteHost: "",
        remoteDirectory: "",
      };
      db.prepare("INSERT OR IGNORE INTO backup_catalog VALUES(?,?,?,?)").run(
        record.id,
        name,
        record.createdAt,
        JSON.stringify(record),
      );
    } catch {
      /* An unfinished legacy copy is not offered for restoration. */
    }
  }

  function settings() {
    const row = db
      .prepare("SELECT data,next_run FROM backup_settings WHERE id=1")
      .get()!;
    return {
      value: JSON.parse(String(row.data)) as BackupSettings,
      next: Number(row.next_run),
    };
  }
  function expiredJob() {
    const row = db
      .prepare("SELECT data,lease_until FROM backup_job WHERE id=1")
      .get();
    if (row && Number(row.lease_until) < now()) {
      const job = JSON.parse(String(row.data)) as BackupJob;
      if (job.state === "running")
        db.prepare(
          "UPDATE backup_job SET data=?,lease_until=0 WHERE id=1 AND lease_until<?",
        ).run(
          JSON.stringify({
            ...job,
            state: "failed",
            error: "Работа прервана перезапуском сервера. Повторите операцию.",
          }),
          now(),
        );
    }
  }
  function status(actorId: string, offset = 0): BackupStatus {
    expiredJob();
    const config = settings(),
      row = db.prepare("SELECT data,actor_id FROM backup_job WHERE id=1").get();
    const job = row ? (JSON.parse(String(row.data)) as BackupJob) : null;
    if (job && row?.actor_id !== actorId) delete job.preview;
    return {
      settings: config.value,
      nextRunAt: config.value.enabled
        ? new Date(config.next).toISOString()
        : null,
      localDirectory: directory,
      sshConfig: remote.config,
      records: db
        .prepare(
          "SELECT data FROM backup_catalog ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?",
        )
        .all(offset)
        .map((r) => JSON.parse(String(r.data)) as BackupRecord),
      total: Number(
        db.prepare("SELECT count(*) AS n FROM backup_catalog").get()!.n,
      ),
      job,
    };
  }
  function save(value: unknown, actor: ArchiveUser) {
    const checked = validateBackupSettings(value),
      old = settings();
    const next =
      checked.enabled !== old.value.enabled ||
      checked.intervalHours !== old.value.intervalHours
        ? now() + checked.intervalHours * hour
        : old.next;
    db.prepare("UPDATE backup_settings SET data=?,next_run=? WHERE id=1").run(
      JSON.stringify(checked),
      next,
    );
    audit.record(
      {
        action: "Настроены резервные копии",
        entity: "settings",
        entityId: "backups",
        label: "Резервные копии",
        personIds: [],
        details: [
          {
            field: "Настройки",
            before: JSON.stringify(old.value),
            after: JSON.stringify(checked),
          },
        ],
      },
      actor,
    );
    return checked;
  }
  function record(id: string): BackupRecord {
    const row = db
      .prepare("SELECT data FROM backup_catalog WHERE id=?")
      .get(id);
    if (!row)
      throw new BackupInputError(
        "Резервная копия не найдена. Обновите список.",
      );
    const r = JSON.parse(String(row.data)) as BackupRecord;
    if (!filePattern.test(r.name))
      throw new BackupInputError("Недопустимое имя резервной копии.");
    return r;
  }
  function log(action: string, label: string, actor?: ArchiveUser) {
    audit.record(
      {
        action,
        entity: "settings",
        entityId: "backups",
        label,
        personIds: [],
        details: [],
      },
      actor,
    );
  }
  function launch(
    kind: BackupJob["kind"],
    actor: ArchiveUser | undefined,
    task: () => Promise<Pick<BackupJob, "preview" | "warning"> | void>,
    scheduled = false,
  ) {
    if (closed) throw new BackupBusyError("Сервер завершает работу.");
    if (pending)
      throw new BackupBusyError(
        "Уже выполняется операция с резервными копиями.",
      );
    if (signal.aborted) {
      controller = new AbortController();
      signal = controller.signal;
    }
    const owner = randomUUID(),
      job: BackupJob = {
        id: owner,
        kind,
        state: "running",
        startedAt: new Date(now()).toISOString(),
      };
    db.exec("BEGIN IMMEDIATE");
    try {
      const occupied = db
        .prepare("SELECT lease_until FROM backup_job WHERE id=1")
        .get();
      if (occupied && Number(occupied.lease_until) > now())
        throw new BackupBusyError(
          "Уже выполняется операция с резервными копиями.",
        );
      const config = settings();
      if (scheduled && (!config.value.enabled || config.next > now())) {
        db.exec("ROLLBACK");
        return null;
      }
      db.prepare(
        "INSERT INTO backup_job VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,actor_id=excluded.actor_id,lease_until=excluded.lease_until,data=excluded.data",
      ).run(owner, actor?.id || "system", now() + 90000, JSON.stringify(job));
      // Persist before starting: another instance/restart must not repeat the interval.
      if (kind === "create")
        db.prepare("UPDATE backup_settings SET next_run=? WHERE id=1").run(
          now() + config.value.intervalHours * hour,
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const heartbeat = setInterval(() => {
      try {
        db.prepare(
          "UPDATE backup_job SET lease_until=? WHERE id=1 AND owner=?",
        ).run(now() + 90000, owner);
      } catch {
        // Stop I/O if the lease cannot be renewed (e.g. a full disk).
        controller.abort();
      }
    }, 15000);
    heartbeat.unref();
    pending = Promise.resolve()
      .then(task)
      .then((result) => {
        Object.assign(job, result, { state: "succeeded" });
        log(
          kind === "create"
            ? "Создана резервная копия"
            : kind === "check"
              ? "Проверено хранилище копий"
              : "Проверен бэкап для восстановления",
          job.startedAt,
          actor,
        );
      })
      .catch((error: unknown) => {
        job.state = "failed";
        job.error =
          error instanceof BackupInputError
            ? error.message
            : signal.aborted
              ? "Операция остановлена при завершении работы сервера."
              : error instanceof Error && !("code" in error)
                ? error.message
                : "Не удалось завершить операцию. Проверьте место на диске и права хранилища.";
        console.error(
          JSON.stringify({
            event: "backup_failed",
            kind,
            jobId: owner,
            error: job.error,
          }),
        );
        log("Ошибка резервного копирования", job.error, actor);
        if (kind === "create")
          db.prepare(
            "UPDATE backup_settings SET next_run=min(next_run,?) WHERE id=1",
          ).run(now() + hour);
      })
      .finally(() => {
        clearInterval(heartbeat);
        db.prepare(
          "UPDATE backup_job SET data=?,lease_until=0 WHERE id=1 AND owner=?",
        ).run(JSON.stringify(job), owner);
        pending = undefined;
      })
      .catch(() => {
        // A failed audit/status write must not become an unhandled rejection
        // and terminate the web process. The expired lease exposes interruption.
        pending = undefined;
        console.error("backup_job_persistence_failed");
      });
    return job;
  }
  async function prune(config: BackupSettings) {
    const sameTarget = (r: BackupRecord) =>
      r.storage === config.storage &&
      (r.storage === "local" ||
        (r.remoteHost === config.remoteHost &&
          r.remoteDirectory === config.remoteDirectory));
    const records = db
      .prepare(
        "SELECT data FROM backup_catalog ORDER BY created_at DESC,id DESC",
      )
      .all()
      .map((r) => JSON.parse(String(r.data)) as BackupRecord)
      .filter(sameTarget);
    for (const item of records.slice(config.keepCount)) {
      signal.throwIfAborted();
      if (item.storage === "remote") await remote.remove(item, signal);
      else {
        await rm(join(directory, item.name), { force: true });
        await rm(join(directory, item.name + ".sha256"), { force: true });
      }
      db.prepare("DELETE FROM backup_catalog WHERE id=?").run(item.id);
    }
  }
  async function create() {
    const config = settings().value;
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
        if ((await lstat(abandoned)).mtimeMs < now() - 48 * hour)
          await rm(abandoned, { recursive: true, force: true });
      }
      let needed = (await stat(databasePath)).size * 2;
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
          fileURLToPath(new URL("./backup-worker.mjs", import.meta.url)),
          databasePath,
          join(stage, "drevo.sqlite"),
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
      db.prepare("INSERT INTO backup_catalog VALUES(?,?,?,?)").run(
        id,
        name,
        item.createdAt,
        JSON.stringify(item),
      );
      try {
        await prune(config);
      } catch {
        return {
          warning:
            "Копия создана, но удалить часть старых копий не удалось. Проверьте хранилище; очистка повторится после следующей успешной копии.",
        };
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  async function withFile<T>(
    id: string,
    consume: (file: string, item: BackupRecord) => Promise<T>,
  ) {
    const item = record(id),
      temporary = await mkdtemp(join(directory, ".download-"));
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
  function startCreate(actor?: ArchiveUser, scheduled = false) {
    return launch("create", actor, create, scheduled);
  }
  function tick() {
    if (closed) return;
    try {
      const config = settings();
      if (config.value.enabled && config.next <= now())
        startCreate(undefined, true);
    } catch (error) {
      if (!(error instanceof BackupBusyError))
        console.error("backup_scheduler_failed");
    }
  }
  const timer = options.schedule === false ? null : setInterval(tick, 30000);
  timer?.unref();
  return {
    status,
    save,
    record,
    withFile,
    startCreate,
    tick,
    check(value: unknown, actor: ArchiveUser) {
      const config = validateBackupSettings(value);
      if (config.storage !== "remote")
        throw new BackupInputError("Выберите отдельный сервер.");
      return launch("check", actor, () => remote.check(config, signal));
    },
    preview(
      id: string,
      actor: ArchiveUser,
      inspect: (file: string, signal: AbortSignal) => Promise<RestorePreview>,
    ) {
      record(id);
      return launch("preview", actor, async () => ({
        preview: await withFile(id, (file) => inspect(file, signal)),
      }));
    },
    async idle() {
      await pending;
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      controller.abort();
      await pending;
    },
  };
}
export type BackupManager = ReturnType<typeof backupManager>;
