import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import { canEditArchive, isArchiveOwner } from "../domain/access.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { accountAiAccess } from "./account-ai-access.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { assertActiveAccountSession, AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";

const MODELS = {
  "face-api-1.7.15": { dimensions: 128, maxValue: 2 },
  "human-faceres-3.3.6": { dimensions: 1024, maxValue: 100 },
} as const;
type FaceModel = keyof typeof MODELS;
const MAX_BODY = 64 * 1024;
const MATCH_DISTANCE = 0.52;
const HUMAN_MIN_MARGIN = 0.08;

type FaceDescriptor = {
  id: string;
  personId: string;
  descriptor: number[];
  sourcePhotoId: string;
  sourceTagId?: string;
  model: FaceModel;
};

function modelSpec(value: unknown) {
  if (typeof value !== "string" || !(value in MODELS))
    throw new Error("Неподдерживаемая модель отпечатка лица");
  return [value as FaceModel, MODELS[value as FaceModel]] as const;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
  return true;
}

function parseDescriptor(value: unknown): FaceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Ожидается отпечаток лица");
  const { id, personId, descriptor, sourcePhotoId, sourceTagId, model } =
    value as Record<string, unknown>;
  const [modelName, spec] = modelSpec(model);
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    typeof personId !== "string" ||
    !personId ||
    personId.length > 200 ||
    typeof sourcePhotoId !== "string" ||
    !/^[a-zA-Z0-9-]{1,200}$/.test(sourcePhotoId) ||
    (sourceTagId !== undefined &&
      (typeof sourceTagId !== "string" ||
        !sourceTagId ||
        sourceTagId.length > 200)) ||
    !Array.isArray(descriptor) ||
    descriptor.length !== spec.dimensions ||
    !descriptor.every(
      (item) =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        Math.abs(item) <= spec.maxValue,
    )
  )
    throw new Error("Некорректный отпечаток лица");
  return {
    id,
    personId,
    descriptor,
    sourcePhotoId,
    sourceTagId: typeof sourceTagId === "string" ? sourceTagId : undefined,
    model: modelName,
  };
}

function parseMatchDescriptor(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Ожидается отпечаток лица");
  const { descriptor, model } = value as Record<string, unknown>;
  // Старый клиент не передавал модель при сравнении; поддерживаем его во время
  // переключения release symlink, пока вкладка не загрузит новый bundle.
  const [modelName, spec] = modelSpec(model ?? "face-api-1.7.15");
  if (
    !Array.isArray(descriptor) ||
    descriptor.length !== spec.dimensions ||
    !descriptor.every(
      (item) =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        Math.abs(item) <= spec.maxValue,
    )
  )
    throw new Error("Некорректный отпечаток лица");
  return { descriptor, model: modelName };
}

function closestMatch(
  descriptor: number[],
  rows: Array<Record<string, unknown>>,
  model: FaceModel,
) {
  let match: { personId: string; squaredDistance: number } | undefined;
  const byPerson =
    model === "human-faceres-3.3.6" ? new Map<string, number>() : null;
  for (const row of rows) {
    let known: unknown;
    try {
      known = JSON.parse(String(row.data));
    } catch {
      continue;
    }
    if (
      !Array.isArray(known) ||
      known.length !== descriptor.length ||
      !known.every((item) => typeof item === "number" && Number.isFinite(item))
    )
      continue;
    let squaredDistance = 0;
    for (let index = 0; index < descriptor.length; index++)
      squaredDistance += (descriptor[index] - known[index]) ** 2;
    const personId = String(row.person_id);
    if (!match || squaredDistance < match.squaredDistance)
      match = { personId, squaredDistance };
    if (byPerson && squaredDistance < (byPerson.get(personId) ?? Infinity))
      byPerson.set(personId, squaredDistance);
  }
  if (!match) return null;
  if (model === "human-faceres-3.3.6") {
    const similarityFor = (squaredDistance: number) => {
      const root = Math.sqrt(25 * squaredDistance) / 100;
      return Math.max(0, Math.min(1, (1 - root - 0.2) / 0.6));
    };
    const similarity = similarityFor(match.squaredDistance);
    if (similarity < 0.5) return null;
    let rivalDistance = Infinity;
    for (const [personId, squaredDistance] of byPerson!)
      if (personId !== match.personId && squaredDistance < rivalDistance)
        rivalDistance = squaredDistance;
    if (
      rivalDistance < Infinity &&
      similarity - similarityFor(rivalDistance) < HUMAN_MIN_MARGIN
    )
      return null;
    return { personId: match.personId, distance: 1 - similarity };
  }
  if (match.squaredDistance > MATCH_DISTANCE ** 2) return null;
  return {
    personId: match.personId,
    distance: Math.sqrt(match.squaredDistance),
  };
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Отпечаток лица слишком большой");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Biometric templates are never included in public family responses. */
export function faceDescriptorsHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  // Matching parses and compares up to 20,000 biometric vectors per request.
  // A single photo is matched sequentially, so this budget still covers
  // unusually large group photos without letting one account monopolize CPU.
  const matchLimiter = createSharedRequestLimiter(archive.db, "face-match", { windowMs: 60_000, limit: 120 });
  const currentWriter = async (req: IncomingMessage, original: { id: string; role: string; personId?: string; treeAccess?: string }) => {
    const latest = await auth.currentUser(req);
    if (!latest?.approved || latest.id !== original.id ||
        latest.role !== original.role ||
        latest.personId !== original.personId ||
        latest.treeAccess !== original.treeAccess ||
        !(await auth.canEdit(req))) return null;
    if (archive.db.kind === "postgres" && !auth.local) {
      const session = await auth.accountSession(req);
      if (!session || session.accountId !== latest.id) return null;
      const lockedSession = await archive.db.prepare("", `SELECT user_id,expires_at
        FROM account_sessions WHERE token_hash=? FOR SHARE SKIP LOCKED`)
        .get(session.tokenHash);
      if (lockedSession?.user_id !== latest.id ||
          Number(lockedSession.expires_at) <= Date.now()) return null;
      const membership = await archive.db.prepare("", `SELECT role,approved,person_id,tree_access
        FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE`)
        .get(archive.db.archiveId || "", latest.id);
      if (!membership?.approved || membership.role !== latest.role ||
          (membership.person_id || "") !== (latest.personId || "") ||
          membership.tree_access !== (latest.treeAccess || "all")) return null;
    }
    if (!(await accountAiAccess(archive.db, latest.id, auth.local, true)))
      return null;
    return latest;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname === "/api/faces/status") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      const user = await auth.currentUser(req);
      return json(res, 200, {
        enabled:
          !!user?.approved &&
          (await auth.canEdit(req)) &&
          (await accountAiAccess(archive.db, user.id, auth.local)),
      });
    }
    const saving = url.pathname === "/api/faces/descriptors";
    const matching = url.pathname === "/api/faces/match";
    const deleting = /^\/api\/faces\/descriptors\/[a-zA-Z0-9-]{1,64}$/.test(
      url.pathname,
    );
    if (!saving && !matching && !deleting) return false;
    const missingActorStatus = async () =>
      archive.db.kind === "postgres" && !auth.local && await auth.accountSession(req)
        ? 403 : 401;
    if (!(await auth.canEdit(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : await missingActorStatus(), {
        error: "You do not have editing access",
      });
    const actor = await auth.currentUser(req);
    if (!actor) return json(res, await missingActorStatus(), {
      error: "Доступ к архиву изменился. Обновите страницу",
    });
    if (!canEditArchive(actor)) return json(res, 403, {
      error: "Нет прав на изменение архива",
    });
    // Keep the issuing token, rather than accepting a later session lookup as
    // authority for a mutation that started under this request.
    const issuingSession = !matching && !auth.local
      ? await auth.accountSession(req) : null;
    if (!matching && !auth.local &&
        (!issuingSession || issuingSession.accountId !== actor.id))
      return json(res, 401, { error: "Сессия завершена. Войдите снова" });
    const assertIssuingSession = async () => {
      if (!issuingSession) return;
      // SQLite serializes writers in BEGIN IMMEDIATE; PostgreSQL retains the
      // session row with NOWAIT until this short mutation commits.
      await assertActiveAccountSession(archive.db, actor.id, issuingSession.tokenHash);
    };
    if (!deleting && !(await accountAiAccess(archive.db, actor.id, auth.local)))
      return json(res, 403, { error: "Распознавание лиц недоступно этому аккаунту" });
    if (deleting && req.method !== "DELETE")
      return json(res, 405, { error: "Ожидается DELETE" });
    if (!deleting && req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Некорректный источник запроса" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      if (!deleting) return json(res, 415, { error: "Ожидается JSON" });
    try {
      if (deleting) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const beforeDelete = await auth.currentUser(req);
        if (!beforeDelete)
          return json(res, await missingActorStatus(), { error: "Доступ к архиву изменился" });
        if (beforeDelete.id !== actor.id || !canEditArchive(beforeDelete))
          return json(res, 403, { error: "Доступ к архиву изменился" });
        const deleted = await archive.db.transaction(async () => {
          await assertIssuingSession();
          await assertCurrentArchiveActor(archive.db, actor);
          if (archive.db.kind === "sqlite" && !auth.local) {
            const latest = await auth.currentUser(req);
            if (!latest || latest.id !== actor.id || !canEditArchive(latest) ||
                latest.role !== actor.role || latest.personId !== actor.personId ||
                latest.treeAccess !== actor.treeAccess ||
                isArchiveOwner(latest) !== isArchiveOwner(actor)) return "access";
          }
          const current = await archive.db.prepare(
            "SELECT created_by,person_id FROM face_descriptors WHERE id=?",
            "SELECT created_by,person_id FROM face_descriptors WHERE id=? FOR UPDATE",
          ).get(id);
          if (!current) return "missing";
          if (isScopedUser(actor) &&
              !visiblePersonIds((await archive.read()).family, actor).has(String(current.person_id)))
            return "access";
          if (!isArchiveOwner(actor) && current.created_by !== actor.id)
            return "access";
          await archive.db.prepare(
            "DELETE FROM face_descriptors WHERE id=?",
            "DELETE FROM face_descriptors WHERE id=?",
          ).run(id);
          await assertIssuingSession();
          return "deleted";
        });
        if (deleted === "missing") return json(res, 404, { error: "Образец не найден" });
        if (deleted === "access") return json(res, 403, { error: "Нет доступа к образцу" });
        return json(res, 200, { ok: true });
      }
      const body = await readJson(req);
      if (matching) {
        const { descriptor, model } = parseMatchDescriptor(body);
        const currentActor = await auth.currentUser(req);
        if (!currentActor || !(await auth.canEdit(req)) ||
            !(await accountAiAccess(archive.db, currentActor.id, auth.local)))
          return json(res, 403, { error: "Доступ к распознаванию лиц изменился" });
        if (!(await matchLimiter.allow(currentActor.id))) {
          res.setHeader("Retry-After", "60");
          return json(res, 429, { error: "Слишком много сравнений лиц. Повторите через минуту" });
        }
        const visible = isScopedUser(currentActor)
          ? visiblePersonIds((await archive.read()).family, currentActor)
          : null;
        const rows = (
          await archive.db
            .prepare(
              "SELECT person_id,data FROM face_descriptors WHERE model=? ORDER BY rowid LIMIT 20001",
              "SELECT person_id,data FROM face_descriptors WHERE model=? ORDER BY ordinal LIMIT 20001",
            )
            .all(model)
        ).filter((row) => !visible || visible.has(String(row.person_id)));
        if (rows.length > 20000)
          return json(res, 503, {
            error: "Слишком много образцов для интерактивного сравнения",
          });
        const match = closestMatch(descriptor, rows, model);
        // Matching can outlive an archive membership or scope change. Hold the
        // membership and tier through delivery, as other AI results do.
        const delivered = await archive.db.transaction(async () => {
          const latest = await currentWriter(req, currentActor);
          if (!latest) return false;
          if (match && isScopedUser(latest) &&
              !visiblePersonIds((await archive.read()).family, latest).has(match.personId))
            return false;
          json(res, 200, { match });
          return true;
        });
        if (!delivered)
          return json(res, 403, { error: "Доступ к распознаванию лиц изменился" });
        return true;
      }
      const sample = parseDescriptor(body);
      const saveActor = await auth.currentUser(req);
      if (!saveActor)
        return json(res, await missingActorStatus(), { error: "Доступ к архиву изменился" });
      if (saveActor.id !== actor.id || !canEditArchive(saveActor))
        return json(res, 403, { error: "Доступ к архиву изменился" });
      if (
        isScopedUser(saveActor) &&
        !visiblePersonIds((await archive.read()).family, saveActor).has(
          sample.personId,
        )
      )
        return json(res, 403, { error: "Нет доступа к человеку" });
      const person = await archive.db
        .prepare(
          "SELECT 1 FROM people WHERE id=?",
          "SELECT 1 FROM people WHERE id=?",
        )
        .get(sample.personId);
      if (!person)
        return json(res, 400, { error: "Человек не найден в архиве" });
      const requestedTagRowId = sample.sourceTagId
        ? `${sample.sourcePhotoId}:${sample.sourceTagId}`
        : null;
      const source = await archive.db
        .prepare(
          `SELECT photo_tags.id AS tag_id, photo_tags.data AS tag, photos.data AS photo
             FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id
            WHERE photos.id=?
              AND photo_tags.person_id=?
              AND (? IS NULL OR photo_tags.id=?)
            ORDER BY photo_tags.rowid DESC
            LIMIT 1`,
          "SELECT photo_tags.id AS tag_id, photo_tags.data AS tag, photos.data AS photo\n             FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id\n            WHERE photos.id=?\n              AND photo_tags.person_id=?\n              AND (?::text IS NULL OR photo_tags.id=?)\n            ORDER BY photo_tags.ordinal DESC\n            LIMIT 1",
        )
        .get(
          sample.sourcePhotoId,
          sample.personId,
          requestedTagRowId,
          requestedTagRowId,
        );
      if (!source)
        return json(res, 400, {
          error: "Отпечаток должен относиться к сохранённой отметке на фото",
        });
      const sourceTagRowId = String(source.tag_id);
      const photo = JSON.parse(String(source.photo)) as { createdBy?: string };
      if (!isArchiveOwner(saveActor) && photo.createdBy !== saveActor.id)
        return json(res, 403, { error: "Нет доступа к исходной фотографии" });
      const saved = await archive.db.transaction(async () => {
        const currentActor = await currentWriter(req, saveActor);
        if (!currentActor) return "access";
        if (isScopedUser(currentActor) &&
            !visiblePersonIds((await archive.read()).family, currentActor).has(sample.personId))
          return "access";
        // Serialize concurrent saves for the same person before enforcing the
        // sample limit. Also refuse a tag that changed while the browser was
        // computing its descriptor.
        const person = await archive.db.prepare(
          "SELECT id FROM people WHERE id=?",
          "SELECT id FROM people WHERE id=? FOR UPDATE",
        ).get(sample.personId);
        if (!person) return "source";
        const currentSource = await archive.db.prepare(
          `SELECT photo_tags.data AS tag, photos.data AS photo FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id
            WHERE photos.id=? AND photo_tags.person_id=? AND photo_tags.id=?`,
          `SELECT photo_tags.data AS tag, photos.data AS photo FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id
            WHERE photos.id=? AND photo_tags.person_id=? AND photo_tags.id=? FOR SHARE OF photos,photo_tags`,
        ).get(sample.sourcePhotoId, sample.personId, sourceTagRowId);
        if (!currentSource || JSON.stringify(currentSource.tag) !== JSON.stringify(source.tag))
          return "source";
        const currentPhoto = JSON.parse(String(currentSource.photo)) as { createdBy?: string };
        if (!isArchiveOwner(currentActor) && currentPhoto.createdBy !== currentActor.id)
          return "access";
        const sampleCountSql = `SELECT count(*) AS n FROM face_descriptors WHERE person_id=? AND model=?
            AND (source_tag_id IS NULL OR source_tag_id<>?)`;
        const count = Number((await archive.db.prepare(sampleCountSql, sampleCountSql)
          .get(sample.personId, sample.model, sourceTagRowId))!.n);
        if (count >= 20) return "limit";
        await archive.db
          .prepare(
            "DELETE FROM face_descriptors WHERE source_tag_id=? AND model=?",
            "DELETE FROM face_descriptors WHERE source_tag_id=? AND model=?",
          )
          .run(sourceTagRowId, sample.model);
        await archive.db
          .prepare(
            `INSERT INTO face_descriptors
               (id,person_id,data,created_by,source_photo_id,source_tag_id,model)
             VALUES(?,?,?,?,?,?,?)`,
            "INSERT INTO face_descriptors\n               (id,person_id,data,created_by,source_photo_id,source_tag_id,model)\n             VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            sample.id,
            sample.personId,
            JSON.stringify(sample.descriptor),
            currentActor.id,
            sample.sourcePhotoId,
            sourceTagRowId,
            sample.model,
          );
        await assertIssuingSession();
        return "saved";
      });
      if (saved === "access") return json(res, 403, { error: "Доступ к распознаванию лиц изменился" });
      if (saved === "source") return json(res, 409, { error: "Отметка на фото изменилась. Повторите распознавание" });
      if (saved === "limit") return json(res, 409, { error: "Для этого человека уже сохранено максимальное число образцов" });
      return json(res, 201, { ok: true });
    } catch (error) {
      if (error instanceof AccountSessionExpired)
        return json(res, 401, { error: error.message });
      if (error instanceof AccountSessionBusy)
        return json(res, 409, { error: error.message });
      if (error instanceof ForbiddenError)
        return json(res, 403, { error: error.message });
      if (isInfrastructureError(error)) throw error;
      return json(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось сохранить отпечаток лица",
      });
    }
  };
}
