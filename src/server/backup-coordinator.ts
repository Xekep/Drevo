import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ArchiveUser } from "../domain/access.ts";
import type {
  BackupJob,
  BackupRecord,
  BackupStatus,
  RestorePreview,
} from "../shared/backup-management.ts";
import { auditStore } from "./audit.ts";
import { backupFiles } from "./backup-files.ts";
import {
  backupStore,
  BackupInputError,
  validateBackupSettings,
} from "./backup-store.ts";
import type { BackupRemote } from "./backup-remote.ts";
const hour = 3600000;
export class BackupBusyError extends Error {}
export function backupCoordinator(
  db: DatabaseSync,
  databasePath: string,
  options: {
    remote?: BackupRemote;
    now?: () => number;
    schedule?: boolean;
  } = {},
) {
  const now = options.now || Date.now;
  const store = backupStore(db, now),
    files = backupFiles(databasePath, options.remote, now);
  const audit = auditStore(db),
    settings = store.settings,
    record = store.record;
  for (const item of files.existingCopies()) store.add(item);
  let controller = new AbortController(),
    signal = controller.signal;
  let pending: Promise<void> | undefined,
    closed = false;
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
      localDirectory: files.directory,
      sshConfig: files.sshConfig,
      ...store.list(offset),
      job,
    };
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
        store.schedule(now() + config.value.intervalHours * hour);
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
        if (kind === "create") store.retryBy(now() + hour);
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

  async function create() {
    const config = settings().value;
    const item = await files.create(config, signal);
    store.add(item);
    try {
      for (const obsolete of store.excess(config)) {
        signal.throwIfAborted();
        await files.remove(obsolete, signal);
        store.forget(obsolete.id);
      }
    } catch {
      return {
        warning:
          "Копия создана, но удалить часть старых копий не удалось. Проверьте хранилище; очистка повторится после следующей успешной копии.",
      };
    }
  }
  function withFile<T>(
    id: string,
    consume: (file: string, item: BackupRecord) => Promise<T>,
  ) {
    return files.withFile(record(id), signal, consume);
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
    save: store.save,
    record,
    withFile,
    startCreate,
    tick,
    check(value: unknown, actor: ArchiveUser) {
      const config = validateBackupSettings(value);
      if (config.storage !== "remote")
        throw new BackupInputError("Выберите отдельный сервер.");
      return launch("check", actor, () => files.check(config, signal));
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
export type BackupCoordinator = ReturnType<typeof backupCoordinator>;
