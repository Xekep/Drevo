import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";

const DIMENSIONS = 128;
const MAX_BODY = 16 * 1024;

type FaceDescriptor = { id: string; personId: string; descriptor: number[] };

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
  const { id, personId, descriptor } = value as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    typeof personId !== "string" ||
    !personId ||
    personId.length > 200 ||
    !Array.isArray(descriptor) ||
    descriptor.length !== DIMENSIONS ||
    !descriptor.every(
      (item) =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        Math.abs(item) <= 2,
    )
  )
    throw new Error("Некорректный отпечаток лица");
  return { id, personId, descriptor };
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
    if (url.pathname !== "/api/faces/descriptors") return false;
    if (!auth.canEdit(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "You do not have editing access",
      });
    if (req.method === "GET") {
      const rows = archive.db
        .prepare(
          "SELECT id,person_id,data FROM face_descriptors ORDER BY rowid",
        )
        .all();
      return json(
        res,
        200,
        rows.map((row) => ({
          id: String(row.id),
          personId: String(row.person_id),
          descriptor: JSON.parse(String(row.data)),
        })),
      );
    }
    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Некорректный источник запроса" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "Ожидается JSON" });
    try {
      const sample = parseDescriptor(await readJson(req));
      const person = archive.db
        .prepare("SELECT 1 FROM people WHERE id=?")
        .get(sample.personId);
      if (!person)
        return json(res, 400, { error: "Человек не найден в архиве" });
      archive.db
        .prepare(
          "INSERT OR IGNORE INTO face_descriptors(id,person_id,data) VALUES(?,?,?)",
        )
        .run(sample.id, sample.personId, JSON.stringify(sample.descriptor));
      return json(res, 201, { ok: true });
    } catch (error) {
      return json(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось сохранить отпечаток лица",
      });
    }
  };
}
