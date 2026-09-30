import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { accountAiAccess } from "./account-ai-access.ts";

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
    if (!(await auth.canEdit(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "You do not have editing access",
      });
    const actor = (await auth.currentUser(req))!;
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
        const row = await archive.db
          .prepare(
            "SELECT created_by,person_id FROM face_descriptors WHERE id=?",
            "SELECT created_by,person_id FROM face_descriptors WHERE id=?",
          )
          .get(id);
        if (!row) return json(res, 404, { error: "Образец не найден" });
        const actor = (await auth.currentUser(req))!;
        if (
          isScopedUser(actor) &&
          !visiblePersonIds((await archive.read()).family, actor).has(
            String(row.person_id),
          )
        )
          return json(res, 403, { error: "Нет доступа к человеку" });
        if (actor.role !== "admin" && row.created_by !== actor.id)
          return json(res, 403, { error: "Нет доступа к образцу" });
        await archive.db
          .prepare(
            "DELETE FROM face_descriptors WHERE id=?",
            "DELETE FROM face_descriptors WHERE id=?",
          )
          .run(id);
        return json(res, 200, { ok: true });
      }
      const body = await readJson(req);
      if (matching) {
        const { descriptor, model } = parseMatchDescriptor(body);
        const actor = (await auth.currentUser(req))!;
        const visible = isScopedUser(actor)
          ? visiblePersonIds((await archive.read()).family, actor)
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
        if (!(await accountAiAccess(archive.db, actor.id, auth.local)))
          return json(res, 403, { error: "Распознавание лиц недоступно этому аккаунту" });
        return json(res, 200, { match });
      }
      const sample = parseDescriptor(body);
      const actor = (await auth.currentUser(req))!;
      if (
        isScopedUser(actor) &&
        !visiblePersonIds((await archive.read()).family, actor).has(
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
          `SELECT photo_tags.id AS tag_id, photos.data AS photo
             FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id
            WHERE photos.id=?
              AND photo_tags.person_id=?
              AND (? IS NULL OR photo_tags.id=?)
            ORDER BY photo_tags.rowid DESC
            LIMIT 1`,
          "SELECT photo_tags.id AS tag_id, photos.data AS photo\n             FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id\n            WHERE photos.id=?\n              AND photo_tags.person_id=?\n              AND (? IS NULL OR photo_tags.id=?)\n            ORDER BY photo_tags.ordinal DESC\n            LIMIT 1",
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
      if (actor.role !== "admin" && photo.createdBy !== actor.id)
        return json(res, 403, { error: "Нет доступа к исходной фотографии" });
      const count = Number(
        (await archive.db
          .prepare(
            `SELECT count(*) AS n
               FROM face_descriptors
              WHERE person_id=?
                AND model=?
                AND (source_tag_id IS NULL OR source_tag_id<>?)`,
            "SELECT count(*) AS n\n               FROM face_descriptors\n              WHERE person_id=?\n                AND model=?\n                AND (source_tag_id IS NULL OR source_tag_id<>?)",
          )
          .get(sample.personId, sample.model, sourceTagRowId))!.n,
      );
      if (count >= 20)
        return json(res, 409, {
          error: "Для этого человека уже сохранено максимальное число образцов",
        });
      const saved = await archive.db.transaction(async () => {
        const currentActor = await auth.currentUser(req);
        if (!currentActor || !(await auth.canEdit(req)) ||
            !(await accountAiAccess(archive.db, currentActor.id, auth.local, true)))
          return false;
        if (isScopedUser(currentActor) &&
            !visiblePersonIds((await archive.read()).family, currentActor).has(sample.personId))
          return false;
        if (currentActor.role !== "admin" && photo.createdBy !== currentActor.id)
          return false;
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
            actor.id,
            sample.sourcePhotoId,
            sourceTagRowId,
            sample.model,
          );
        return true;
      });
      if (!saved) return json(res, 403, { error: "Доступ к распознаванию лиц изменился" });
      return json(res, 201, { ok: true });
    } catch (error) {
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
