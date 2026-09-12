import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";

const MODELS = {
  "face-api-1.7.15": { dimensions: 128, maxValue: 2 },
  "human-faceres-3.3.6": { dimensions: 1024, maxValue: 100 },
} as const;
type FaceModel = keyof typeof MODELS;
const MAX_BODY = 64 * 1024;
const MATCH_DISTANCE = 0.52;

type FaceDescriptor = {
  id: string;
  personId: string;
  descriptor: number[];
  sourcePhotoId: string;
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
  const { id, personId, descriptor, sourcePhotoId, model } = value as Record<
    string,
    unknown
  >;
  const [modelName, spec] = modelSpec(model);
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    typeof personId !== "string" ||
    !personId ||
    personId.length > 200 ||
    typeof sourcePhotoId !== "string" ||
    !/^[a-zA-Z0-9-]{1,200}$/.test(sourcePhotoId) ||
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
  return { id, personId, descriptor, sourcePhotoId, model: modelName };
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
    if (!match || squaredDistance < match.squaredDistance)
      match = { personId: String(row.person_id), squaredDistance };
  }
  if (!match) return null;
  if (model === "human-faceres-3.3.6") {
    const root = Math.sqrt(25 * match.squaredDistance) / 100,
      similarity = Math.max(0, Math.min(1, (1 - root - 0.2) / 0.6));
    if (similarity < 0.5) return null;
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
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  publicOrigin?: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const saving = url.pathname === "/api/faces/descriptors";
    const matching = url.pathname === "/api/faces/match";
    const deleting = /^\/api\/faces\/descriptors\/[a-zA-Z0-9-]{1,64}$/.test(
      url.pathname,
    );
    if (!saving && !matching && !deleting) return false;
    if (!auth.canEdit(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "You do not have editing access",
      });
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
        const row = archive.db
          .prepare("SELECT created_by FROM face_descriptors WHERE id=?")
          .get(id);
        if (!row) return json(res, 404, { error: "Образец не найден" });
        const actor = auth.currentUser(req)!;
        if (actor.role !== "admin" && row.created_by !== actor.id)
          return json(res, 403, { error: "Нет доступа к образцу" });
        archive.db.prepare("DELETE FROM face_descriptors WHERE id=?").run(id);
        return json(res, 200, { ok: true });
      }
      const body = await readJson(req);
      if (matching) {
        const { descriptor, model } = parseMatchDescriptor(body);
        const rows = archive.db
          .prepare(
            "SELECT person_id,data FROM face_descriptors WHERE model=? ORDER BY rowid LIMIT 20001",
          )
          .all(model);
        if (rows.length > 20000)
          return json(res, 503, {
            error: "Слишком много образцов для интерактивного сравнения",
          });
        return json(res, 200, { match: closestMatch(descriptor, rows, model) });
      }
      const sample = parseDescriptor(body);
      const actor = auth.currentUser(req)!;
      const person = archive.db
        .prepare("SELECT 1 FROM people WHERE id=?")
        .get(sample.personId);
      if (!person)
        return json(res, 400, { error: "Человек не найден в архиве" });
      const source = archive.db
        .prepare(
          `SELECT photos.data AS photo
             FROM photos JOIN photo_tags ON photo_tags.photo_id=photos.id
            WHERE photos.id=? AND photo_tags.person_id=? LIMIT 1`,
        )
        .get(sample.sourcePhotoId, sample.personId);
      if (!source)
        return json(res, 400, {
          error: "Отпечаток должен относиться к сохранённой отметке на фото",
        });
      const photo = JSON.parse(String(source.photo)) as { createdBy?: string };
      if (
        actor.role !== "admin" &&
        photo.createdBy !== actor.id
      )
        return json(res, 403, { error: "Нет доступа к исходной фотографии" });
      const count = Number(
        archive.db
          .prepare("SELECT count(*) AS n FROM face_descriptors WHERE person_id=?")
          .get(sample.personId)!.n,
      );
      if (count >= 20)
        return json(res, 409, {
          error: "Для этого человека уже сохранено максимальное число образцов",
        });
      archive.db
        .prepare(
          `INSERT OR IGNORE INTO face_descriptors
             (id,person_id,data,created_by,source_photo_id,model)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          sample.id,
          sample.personId,
          JSON.stringify(sample.descriptor),
          actor.id,
          sample.sourcePhotoId,
          sample.model,
        );
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
