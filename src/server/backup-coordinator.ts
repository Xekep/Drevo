import type { StoreDatabase } from "./store-database.ts";
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
export async function backupCoordinator(
  db: StoreDatabase,
  databasePath: string,
  options: {
    remote?: BackupRemote;
    now?: () => number;
    schedule?: boolean;
  } = {},
) {
  const now = options.now || Date.now;
  const store = await backupStore(db, now),
    files = backupFiles(
      databasePath,
      options.remote,
      now,
      db.kind === "postgres"
        ? async () =>
            Number(
              (await db
                .prepare(
                  "",
                  "SELECT pg_database_size(current_database()) AS bytes",
                )
                .get())!.bytes,
            )
        : undefined,
    );
  const audit = auditStore(db),
    settings = store.settings,
    record = store.record;
  for (const item of files.existingCopies()) await store.add(item);
  let controller = new AbortController(),
    signal = controller.signal;
  let pending: Promise<void> | undefined,
    closed = false;
  async function expiredJob() {
    const row = await db
      .prepare(
        "SELECT data,lease_until FROM backup_job WHERE id=1",
        "SELECT data,lease_until FROM backup_job WHERE id=1",
      )
      .get();
    if (row && Number(row.lease_until) < now()) {
      const job = JSON.parse(String(row.data)) as BackupJob;
      if (job.state === "running")
        await db
          .prepare(
            "UPDATE backup_job SET data=?,lease_until=0 WHERE id=1 AND lease_until<?",
            "UPDATE backup_job SET data=?,lease_until=0 WHERE id=1 AND lease_until<?",
          )
          .run(
            JSON.stringify({
              ...job,
              state: "failed",
              error:
                "Работа прервана перезапуском сервера. Повторите операцию.",
            }),
            now(),
          );
    }
  }
  async function status(actorId: string, offset = 0): Promise<BackupStatus> {
    await expiredJob();
    const config = await settings(),
      row = await db
        .prepare(
          "SELECT data,actor_id FROM backup_job WHERE id=1",
          "SELECT data,actor_id FROM backup_job WHERE id=1",
        )
        .get();
    const job = row ? (JSON.parse(String(row.data)) as BackupJob) : null;
    if (job && row?.actor_id !== actorId) delete job.preview;
    return {
      settings: config.value,
      nextRunAt: config.value.enabled
        ? new Date(config.next).toISOString()
        : null,
      localDirectory: files.directory,
      sshConfig: files.sshConfig,
      ...(await store.list(offset)),
      job,
    };
  }
  async function log(action: string, label: string, actor?: ArchiveUser) {
    await audit.record(
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
  async function launch(
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
    const acquired = await db.transaction(async () => {
      const occupied = await db
        .prepare(
          "SELECT lease_until FROM backup_job WHERE id=1",
          "SELECT lease_until FROM backup_job WHERE id=1",
        )
        .get();
      if (occupied && Number(occupied.lease_until) > now())
        throw new BackupBusyError(
          "Уже выполняется операция с резервными копиями.",
        );
      const config = await settings();
      if (scheduled && (!config.value.enabled || config.next > now())) {
        return null;
      }
      await db
        .prepare(
          "INSERT INTO backup_job VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,actor_id=excluded.actor_id,lease_until=excluded.lease_until,data=excluded.data",
          "INSERT INTO backup_job(id,owner,actor_id,lease_until,data) VALUES(1,?,?,?,?) ON CONFLICT(archive_id,id) DO UPDATE SET owner=excluded.owner,actor_id=excluded.actor_id,lease_until=excluded.lease_until,data=excluded.data",
        )
        .run(owner, actor?.id || "system", now() + 90000, JSON.stringify(job));
      // Persist before starting: another instance/restart must not repeat the interval.
      if (kind === "create")
        await store.schedule(now() + config.value.intervalHours * hour);

      return true;
    });
    if (!acquired) return null;
    const heartbeat = setInterval(async () => {
      try {
        const renewed = await db
          .prepare(
            "UPDATE backup_job SET lease_until=? WHERE id=1 AND owner=?",
            "UPDATE backup_job SET lease_until=? WHERE id=1 AND owner=?",
          )
          .run(now() + 90000, owner);
        if (!renewed.changes) controller.abort();
      } catch {
        // Stop I/O if the lease cannot be renewed (e.g. a full disk).
        controller.abort();
      }
    }, 15000);
    heartbeat.unref();
    pending = Promise.resolve()
      .then(task)
      .then(async (result) => {
        Object.assign(job, result, { state: "succeeded" });
        await log(
          kind === "create"
            ? "Создана резервная копия"
            : kind === "check"
              ? "Проверено хранилище копий"
              : "Проверен бэкап для восстановления",
          job.startedAt,
          actor,
        );
      })
      .catch(async (error: unknown) => {
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
        await log("Ошибка резервного копирования", job.error, actor);
        if (kind === "create") await store.retryBy(now() + hour);
      })
      .finally(async () => {
        clearInterval(heartbeat);
        await db
          .prepare(
            "UPDATE backup_job SET data=?,lease_until=0 WHERE id=1 AND owner=?",
            "UPDATE backup_job SET data=?,lease_until=0 WHERE id=1 AND owner=?",
          )
          .run(JSON.stringify(job), owner);
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
    const config = (await settings()).value;
    const item = await files.create(config, signal);
    await store.add(item);
    try {
      for (const obsolete of await store.excess(config)) {
        signal.throwIfAborted();
        await files.remove(obsolete, signal);
        await store.forget(obsolete.id);
      }
    } catch {
      return {
        warning:
          "Копия создана, но удалить часть старых копий не удалось. Проверьте хранилище; очистка повторится после следующей успешной копии.",
      };
    }
  }
  async function withFile<T>(
    id: string,
    consume: (file: string, item: BackupRecord) => Promise<T>,
  ) {
    return files.withFile(await record(id), signal, consume);
  }
  async function startCreate(actor?: ArchiveUser, scheduled = false) {
    return await launch("create", actor, create, scheduled);
  }
  async function tick() {
    if (closed) return;
    try {
      const config = await settings();
      if (config.value.enabled && config.next <= now())
        await startCreate(undefined, true);
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
    async check(value: unknown, actor: ArchiveUser) {
      const config = validateBackupSettings(value);
      if (config.storage !== "remote")
        throw new BackupInputError("Выберите отдельный сервер.");
      return await launch("check", actor, () => files.check(config, signal));
    },
    async preview(
      id: string,
      actor: ArchiveUser,
      inspect: (file: string, signal: AbortSignal) => Promise<RestorePreview>,
    ) {
      await record(id);
      return await launch("preview", actor, async () => ({
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
export type BackupCoordinator = Awaited<ReturnType<typeof backupCoordinator>>;
