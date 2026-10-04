import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { readdir, rm, stat, statfs } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import { accountCapacity } from "./account-capacity.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { applyPortablePackage, portableStoreOccupied } from "./portable-apply.ts";
import { isArchiveOwner } from "../domain/access.ts";
import {
  PORTABLE_IMPORT_LIMIT,
  portableUncompressedBytes,
  readPortablePackage,
} from "./portable-import.ts";
import { installPortableOriginals } from "./portable-install.ts";
import { PortablePackageError } from "./portable-package.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { mediaStore } from "./media.ts";
import { reservePlatformDisk } from "./platform-disk-reservation.ts";
import { uploadQuota, UploadQuotaError } from "./upload-quota.ts";
import { ForbiddenError } from "./users.ts";

const STAGE_LIFETIME = 30 * 60_000;
const tokenPattern = /^[a-f0-9-]{36}$/;
function stageStatus(value: unknown) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  return data && typeof data === "object" && "status" in data
    ? (data as { status: unknown }).status
    : null;
}
function readyStage(value: unknown) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  if (!data || typeof data !== "object" ||
    (data as { status?: unknown }).status !== "ready" ||
    typeof (data as { manifestSha256?: unknown }).manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test((data as { manifestSha256: string }).manifestSha256))
    return null;
  return data as { status: "ready"; manifestSha256: string };
}

export function portableImportHttp(
  archive: Awaited<ReturnType<typeof openArchive>>,
  auth: Awaited<ReturnType<typeof createAuth>>,
  dbPath: string,
  publicOrigin?: string,
) {
  const db = archive.db;
  const root = join(dirname(dbPath), "staging", "portable");
  const uploads = join(dirname(dbPath), "uploads");
  mkdirSync(root, { recursive: true });
  mkdirSync(uploads, { recursive: true });
  const media = mediaStore(uploads);
  const quota = uploadQuota(db, {
    reservationMs: 30 * 60_000,
    renewEveryMs: 60_000,
  });
  const stagePath = (token: string) => {
    if (!tokenPattern.test(token))
      throw new PortablePackageError("Некорректный токен импорта");
    return join(root, token);
  };
  const owner =
    db.kind === "postgres"
      ? db.prepare("", "SELECT 1 FROM archive_owners WHERE user_id=?")
      : null;
  async function mayImport(req: IncomingMessage) {
    const actor = await auth.currentUser(req);
    if (!actor?.approved || !isArchiveOwner(actor)) return null;
    if (!auth.local && !(await owner?.get(actor.id))) return null;
    return actor;
  }
  async function cleanup() {
    const expired = await db
      .prepare(
        "SELECT token FROM workflow_stages WHERE kind='drevo' AND expires_at<=?",
        "SELECT token FROM workflow_stages WHERE kind='drevo' AND expires_at<=?",
      )
      .all(Date.now());
    for (const row of expired) {
      const token = String(row.token);
      const deleted = await db
        .prepare(
          "DELETE FROM workflow_stages WHERE kind='drevo' AND token=? AND expires_at<=?",
          "DELETE FROM workflow_stages WHERE kind='drevo' AND token=? AND expires_at<=?",
        )
        .run(token, Date.now());
      if (deleted.changes)
        await rm(stagePath(token), { recursive: true, force: true });
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !tokenPattern.test(entry.name)) continue;
      const path = stagePath(entry.name);
      const present = await db
        .prepare(
          "SELECT 1 FROM workflow_stages WHERE kind='drevo' AND token=?",
          "SELECT 1 FROM workflow_stages WHERE kind='drevo' AND token=?",
        )
        .get(entry.name);
      if (!present) {
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < Date.now() - STAGE_LIFETIME)
          await rm(path, { recursive: true, force: true });
      }
    }
  }
  let sweeping: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (sweeping) return;
    const sweep = db.withExclusiveArchiveTask
      ? db.withExclusiveArchiveTask("portable-import", cleanup).then(() => {})
      : cleanup();
    sweeping = sweep
      .catch(() => console.warn("portable_stage_cleanup_failed"))
      .finally(() => {
        sweeping = undefined;
      });
  }, 60_000);
  timer.unref();

  async function empty() {
    const current = await archive.read();
    return (
      !current.family.people.length &&
      !current.family.photos?.length &&
      !(await portableStoreOccupied(db))
    );
  }

  async function parsePackage(input: string, directory: string) {
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof PortablePackageError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOSPC")
          throw new PortablePackageError(
            "Недостаточно места для распаковки пакета Drevo",
          );
        throw new PortablePackageError(
          "Некорректный или повреждённый пакет Drevo",
        );
      }
    };
    const unpackedBytes = await read(() => portableUncompressedBytes(input));
    const reserve = unpackedBytes
      ? await reservePlatformDisk(
          db,
          unpackedBytes,
          async () => {
            const disk = await statfs(directory);
            return disk.bavail * disk.bsize;
          },
          { freeReserve: 128 * 1024 ** 2 },
        )
      : undefined;
    try {
      const parsed = await read(() => readPortablePackage(input, directory));
      await reserve?.assertValid();
      return parsed;
    } finally {
      await reserve?.release();
    }
  }

  async function preview(req: IncomingMessage, actorId: string) {
    if (!(await empty()))
      throw new ConflictError(
        "Переносимый архив можно импортировать только в пустое дерево",
      );
    const length =
      req.headers["content-length"] === undefined
        ? null
        : Number(req.headers["content-length"]);
    if (
      length !== null &&
      (!Number.isSafeInteger(length) ||
        length < 1 ||
        length > PORTABLE_IMPORT_LIMIT)
    )
      throw new PortablePackageError("Укажите файл .drevo размером до 12 ГиБ");
    const token = randomUUID();
    const directory = stagePath(token);
    const current = await archive.read();
    const old = await db
      .prepare(
        "SELECT token,data FROM workflow_stages WHERE kind='drevo' AND actor_id=?",
        "SELECT token,data FROM workflow_stages WHERE kind='drevo' AND actor_id=?",
      )
      .all(actorId);
    for (const row of old) {
      if (["pending", "applying"].includes(String(stageStatus(row.data))))
        throw new ConflictError("Импорт уже выполняется");
      const deleted = await db
        .prepare(
          "DELETE FROM workflow_stages WHERE kind='drevo' AND token=? AND actor_id=? AND data=?",
          "DELETE FROM workflow_stages WHERE kind='drevo' AND token=? AND actor_id=? AND data=?::jsonb",
        )
        .run(String(row.token), actorId,
          typeof row.data === "string" ? row.data : JSON.stringify(row.data));
      if (!deleted.changes) throw new ConflictError("Импорт уже выполняется");
      await rm(stagePath(String(row.token)), { recursive: true, force: true });
    }
    const inserted = await db
      .prepare(
        "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data) SELECT ?,'drevo',?,?,?,? WHERE (SELECT count(*) FROM workflow_stages WHERE kind='drevo')<2 ON CONFLICT(kind,actor_id) DO NOTHING",
        "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data) SELECT ?,'drevo',?,?,?,? WHERE (SELECT count(*) FROM workflow_stages WHERE kind='drevo')<2 ON CONFLICT(archive_id,kind,actor_id) DO NOTHING",
      )
      .run(
        token,
        actorId,
        current.revision,
        Date.now() + STAGE_LIFETIME,
        JSON.stringify({ status: "pending" }),
      )
      .catch((error: unknown) => {
        if (db.kind === "postgres" && (error as { code?: string }).code === "P5502")
          throw new ConflictError("Уже проверяются другие архивы. Повторите позже");
        throw error;
      });
    if (!inserted.changes) {
      const competing = await db
        .prepare(
          "SELECT token FROM workflow_stages WHERE kind='drevo' AND actor_id=?",
          "SELECT token FROM workflow_stages WHERE kind='drevo' AND actor_id=?",
        )
        .get(actorId);
      throw new ConflictError(
        competing
          ? "Импорт уже выполняется"
          : "Уже проверяются другие архивы. Повторите позже",
      );
    }
    mkdirSync(directory, { recursive: true });
    const heartbeat = setInterval(() => {
      void db
        .prepare(
          "UPDATE workflow_stages SET expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND data=?",
          "UPDATE workflow_stages SET expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND data=?::jsonb",
        )
        .run(
          Date.now() + STAGE_LIFETIME,
          token,
          actorId,
          JSON.stringify({ status: "pending" }),
        )
        .catch(() => {
          console.warn("portable_stage_heartbeat_failed");
        });
    }, 60_000);
    heartbeat.unref();
    let ready = false;
    let inputReserve: Awaited<ReturnType<typeof reservePlatformDisk>> | undefined;
    try {
      let reservedBytes = length ?? 512 * 1024 ** 2;
      inputReserve = await reservePlatformDisk(
        db,
        reservedBytes,
        async () => {
          const disk = await statfs(directory);
          return disk.bavail * disk.bsize;
        },
        { freeReserve: length === null ? 128 * 1024 ** 2 : 512 * 1024 ** 2 },
      );
      let size = 0;
      let nextDiskCheck = 64 * 1024 ** 2;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > PORTABLE_IMPORT_LIMIT)
            return callback(new PortablePackageError("Пакет Drevo больше 12 ГиБ"));
          const needsGrowth = length === null &&
            size >= reservedBytes - 64 * 1024 ** 2 &&
            reservedBytes < PORTABLE_IMPORT_LIMIT;
          const needsDiskCheck = size >= nextDiskCheck;
          if (!needsGrowth && !needsDiskCheck) return callback(null, chunk);
          void (async () => {
            if (needsGrowth) {
              const additional = Math.min(512 * 1024 ** 2, PORTABLE_IMPORT_LIMIT - reservedBytes);
              await inputReserve!.grow(additional);
              reservedBytes += additional;
            }
            if (needsDiskCheck) {
              const space = await statfs(directory);
              if (space.bavail * space.bsize < 128 * 1024 ** 2)
                throw new PortablePackageError("Недостаточно места для пакета Drevo");
              nextDiskCheck = size + 64 * 1024 ** 2;
            }
          })().then(() => callback(null, chunk), callback);
        },
      });
      const input = join(directory, "input");
      await pipeline(req, guard, createWriteStream(input, { flags: "wx" }), {
        signal: AbortSignal.timeout(2 * 60 * 60_000),
      });
      if (length !== null && size !== length)
        throw new PortablePackageError("Передан неполный файл");
      await inputReserve.assertValid();
      await inputReserve.release();
      inputReserve = undefined;
      const parsed = await parsePackage(input, directory);
      if (parsed.snapshot.family.people.length > 10_000)
        throw new PortablePackageError("В пакете больше 10 000 людей");
      const summary = {
        token,
        revision: current.revision,
        title: parsed.snapshot.family.title,
        people: parsed.snapshot.family.people.length,
        photos: parsed.snapshot.family.photos?.length || 0,
        documents: parsed.snapshot.documents.length,
        comments: parsed.snapshot.comments.length,
        bytes: [...parsed.files.entries()]
          .filter(([name]) => name.startsWith("media/"))
          .reduce((sum, [, file]) => sum + file.size, 0),
      };
      const capacity = await accountCapacity(db, actorId);
      const limits: string[] = [];
      if (capacity.available && capacity.owned && !capacity.fullAccess) {
        if (capacity.people + summary.people > capacity.peopleLimit)
          limits.push(`Лимит людей: ${capacity.peopleLimit}`);
        if (
          capacity.mediaBytes === null ||
          capacity.mediaBytes + summary.bytes > capacity.mediaLimitBytes
        )
          limits.push("Лимит фотографий и документов: 500 МБ");
      }
      const currentActor = await mayImport(req);
      if (!currentActor || currentActor.id !== actorId)
        throw new ForbiddenError("Доступ владельца отозван");
      for (const file of parsed.files.values())
        await rm(file.path, { force: true });
      const updated = await db
        .prepare(
          "UPDATE workflow_stages SET data=?,expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND expires_at>?",
          "UPDATE workflow_stages SET data=?,expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND expires_at>?",
        )
        .run(
          JSON.stringify({ status: "ready",
            manifestSha256: parsed.files.get("manifest.json")!.sha256 }),
          Date.now() + STAGE_LIFETIME,
          token,
          actorId,
          Date.now(),
        );
      if (!updated.changes)
        throw new ConflictError("Предпросмотр импорта истёк");
      ready = true;
      return {
        ...summary,
        canImport: limits.length === 0,
        warning: limits.length ? limits.join("; ") : null,
      };
    } finally {
      clearInterval(heartbeat);
      try {
        if (!ready) {
          await db
            .prepare(
              "DELETE FROM workflow_stages WHERE kind='drevo' AND token=?",
              "DELETE FROM workflow_stages WHERE kind='drevo' AND token=?",
            )
            .run(token);
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        await inputReserve?.release().catch(() => {
          console.warn("portable_preview_reservation_release_failed");
        });
      }
    }
  }

  async function apply(req: IncomingMessage, actorId: string) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096)
        throw new PortablePackageError("Слишком большой запрос подтверждения");
      chunks.push(Buffer.from(chunk));
    }
    let body: { confirm?: boolean; token?: string };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new PortablePackageError("Некорректное подтверждение импорта");
    }
    if (
      body.confirm !== true ||
      typeof body.token !== "string" ||
      !tokenPattern.test(body.token)
    )
      throw new PortablePackageError("Подтвердите проверенный импорт");
    const row = await db
      .prepare(
        "SELECT actor_id,revision,expires_at,data FROM workflow_stages WHERE kind='drevo' AND token=?",
        "SELECT actor_id,revision,expires_at,data FROM workflow_stages WHERE kind='drevo' AND token=?",
      )
      .get(body.token);
    const previewed = row && readyStage(row.data);
    if (
      !row ||
      row.actor_id !== actorId ||
      Number(row.expires_at) <= Date.now() ||
      !previewed
    )
      throw new ConflictError(
        "Предпросмотр импорта истёк или уже используется",
      );
    const claimed = await db
      .prepare(
        "UPDATE workflow_stages SET data=?,expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND data=? AND expires_at>?",
        "UPDATE workflow_stages SET data=?,expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND data=?::jsonb AND expires_at>?",
      )
      .run(
        JSON.stringify({ status: "applying",
          manifestSha256: previewed.manifestSha256 }),
        Date.now() + 2 * 60 * 60_000,
        body.token,
        actorId,
        JSON.stringify(previewed),
        Date.now(),
      );
    if (!claimed.changes) throw new ConflictError("Импорт уже выполняется");
    const directory = stagePath(body.token);
    let installed:
      Awaited<ReturnType<typeof installPortableOriginals>> | undefined;
    let release: Awaited<ReturnType<typeof quota.acquire>> | undefined;
    let committed = false;
    try {
      if (!(await empty()))
        throw new ConflictError("Дерево изменилось после предпросмотра");
      const parsed = await parsePackage(join(directory, "input"), directory);
      if (parsed.files.get("manifest.json")!.sha256 !== previewed.manifestSha256)
        throw new ConflictError("Пакет Drevo изменился после предпросмотра; проверьте его заново");
      const originalFiles = [...parsed.files].filter(([path]) =>
        path.startsWith("media/"),
      );
      if (originalFiles.length)
        release = await quota.acquire(
          actorId,
          originalFiles.reduce((sum, [, file]) => sum + file.size, 0),
          async () => {
            const disk = await statfs(uploads);
            return disk.bavail * disk.bsize;
          },
          async () => {
            const usage = await media.usage(true);
            return {
              ...usage,
              files: usage.files + originalFiles.length - 1,
            };
          },
        );
      installed = await installPortableOriginals(parsed, uploads);
      const actor = await mayImport(req);
      if (!actor || actor.id !== actorId)
        throw new ForbiddenError("Доступ владельца отозван");
      await release?.assertValid();
      const result = await applyPortablePackage(
        archive,
        actor,
        body.token,
        Number(row.revision),
        installed,
      );
      committed = true;
      installed = undefined;
      await rm(directory, { recursive: true, force: true }).catch(() => {
        console.warn("portable_stage_cleanup_failed");
      });
      return {
        revision: result.revision,
        people: result.family.people.length,
        photos: result.family.photos?.length || 0,
        documents: parsed.snapshot.documents.length,
      };
    } finally {
      try {
        await installed?.undo();
        if (!committed) {
          await db
            .prepare(
              "UPDATE workflow_stages SET data=?,expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND expires_at>?",
              "UPDATE workflow_stages SET data=?,expires_at=? WHERE kind='drevo' AND token=? AND actor_id=? AND expires_at>?",
            )
            .run(
              JSON.stringify(previewed),
              Date.now() + STAGE_LIFETIME,
              body.token,
              actorId,
              Date.now(),
            );
        }
        if (!committed)
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          }).catch(() => []))
            if (entry.isFile() && entry.name !== "input")
              await rm(join(directory, entry.name), { force: true });
      } finally {
        await release?.().catch(() => {
          console.warn("portable_import_reservation_release_failed");
        });
      }
    }
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (!["/api/drevo/preview", "/api/drevo/import"].includes(url.pathname))
        return false;
      const json = (status: number, data: unknown) => {
        if (!res.destroyed) {
          res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(data));
        }
        return true;
      };
      if (req.method !== "POST") return json(405, { error: "Ожидается POST" });
      if (!isSameOriginRequest(req, publicOrigin))
        return json(403, { error: "Недопустимый источник запроса" });
      if (req.headers["x-drevo-import"] !== "1")
        return json(400, { error: "Откройте импорт в личном кабинете" });
      const actor = await mayImport(req);
      if (!actor)
        return json((await auth.currentUser(req)) ? 403 : 401, {
          error: "Импорт доступен владельцу дерева",
        });
      try {
        const performImport = async () => {
          await cleanup();
          return url.pathname.endsWith("preview")
            ? await preview(req, actor.id)
            : await apply(req, actor.id);
        };
        if (!db.withExclusiveArchiveTask)
          return json(200, await performImport());
        const task = await db.withExclusiveArchiveTask(
          "portable-import", performImport,
        );
        return task.acquired
          ? json(200, task.value)
          : json(409, { error: "Импорт уже выполняется" });
      } catch (error) {
        const status =
          error instanceof ConflictError
            ? 409
            : error instanceof ForbiddenError
              ? 403
              : error instanceof UploadQuotaError
                ? error.status
              : error instanceof PortablePackageError
                ? 400
                : 500;
        if (status === 500) console.error("portable_import_failed", error);
        return json(status, {
          error:
            status === 500
              ? "Не удалось импортировать архив"
              : (error as Error).message,
        });
      }
    },
    async close() {
      clearInterval(timer);
      await sweeping;
    },
  };
}
