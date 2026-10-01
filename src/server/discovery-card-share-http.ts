import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";

const fields = ["birth", "death", "birthPlace", "deathPlace", "occupation"] as const;
type Field = typeof fields[number];
type CardFields = Partial<Record<Field, string>>;
type Row = Record<string, unknown>;
const limits: Record<Field, number> = {
  birth: 100, death: 100, birthPlace: 300, deathPlace: 300, occupation: 200,
};
const route = /^\/api\/discovery\/matches\/([a-f0-9-]{36})\/card-share(?:\/(copy-preview))?$/;

function scalarFields(value: unknown, own = false): CardFields {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const result: CardFields = {};
  for (const key of fields) {
    const current = source[key];
    if (typeof current !== "string") continue;
    const text = current.trim();
    if (text && (own || (text.length <= limits[key] && !/[<>]/u.test(text))))
      result[key] = text;
  }
  return result;
}

function previewToken(available: CardFields) {
  return createHash("sha256").update(JSON.stringify(available)).digest("hex");
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) return null;
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function selectedFields(value: unknown): Field[] | null {
  if (!Array.isArray(value) || !value.length || value.length > fields.length ||
      value.some((item) => typeof item !== "string" || !fields.includes(item as Field)) ||
      new Set(value).size !== value.length) return null;
  return value as Field[];
}

function pairArgs(row: Row) {
  return [String(row.left_archive_id),String(row.left_person_id),
    String(row.right_archive_id),String(row.right_person_id)];
}

/** Extra details require a separate, revocable grant for exactly one confirmed pair. */
export function discoveryCardShareHttp({ archive, auth, publicOrigin }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const db = archive.db;
  const limiter = createSharedRequestLimiter(db, "discovery-card-share", { windowMs: 60_000, limit: 20 });
  const json = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const linkedPair = (id: string, archiveId: string, lock = false) => db.prepare("", `
    SELECT m.left_archive_id,m.left_person_id,m.right_archive_id,m.right_person_id
      FROM discovery_match_requests m
      JOIN discovery_linked_pairs p ON p.left_archive_id=m.left_archive_id
        AND p.left_person_id=m.left_person_id AND p.right_archive_id=m.right_archive_id
        AND p.right_person_id=m.right_person_id
     WHERE m.id=? AND m.status='linked'
       AND (m.left_archive_id=? OR m.right_archive_id=?)
     ${lock ? "FOR UPDATE OF m FOR SHARE OF p" : ""}`).get(id,archiveId,archiveId);
  const grantsFor = (pair: Row) => db.prepare("", `SELECT grantor_archive_id,fields,
    granted_by,granted_at::text AS granted_at FROM discovery_linked_card_grants
    WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?`)
    .all(...pairArgs(pair));
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const detail = route.exec(url.pathname);
    if (!detail) return false;
    if (db.kind !== "postgres" || !db.archiveId)
      return json(res, 501, { error: "Доступ к связанной карточке доступен с PostgreSQL" });
    const user = await auth.currentUser(req);
    if (!user) return json(res, 401, { error: "Войдите в архив" });
    if (user.role !== "admin" || user.approved !== true)
      return json(res, 403, { error: "Доступно владельцу дерева" });
    if (detail[2]) {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      const archiveId = db.archiveId;
      const result = await db.transaction(async () => {
        const owner = await db.prepare("", `SELECT 1 FROM archive_owners
          WHERE archive_id=? AND user_id=?`).get(archiveId, user.id);
        if (!owner) return { code: 403 };
        const pair = await linkedPair(detail[1], archiveId);
        if (!pair) return { code: 404 };
        const ownPersonId = String(pair.left_archive_id === archiveId
          ? pair.left_person_id : pair.right_person_id);
        const sourceArchiveId = String(pair.left_archive_id === archiveId
          ? pair.right_archive_id : pair.left_archive_id);
        const sourcePersonId = String(pair.left_archive_id === archiveId
          ? pair.right_person_id : pair.left_person_id);
        const own = await db.prepare("", "SELECT data FROM people WHERE archive_id=? AND id=?")
          .get(archiveId, ownPersonId);
        if (!own) return { code: 404 };
        const incoming = (await grantsFor(pair)).find((row) =>
          row.grantor_archive_id === sourceArchiveId);
        if (!incoming) return { code: 404 };
        const permitted = scalarFields(incoming.fields);
        const target = scalarFields(own.data, true);
        // This preview compares scalars on an existing linked person. It cannot
        // create a person, attach media, or apply a change to either archive.
        return { code: 200, source: { archiveId: sourceArchiveId, personId: sourcePersonId },
          target: { archiveId, personId: ownPersonId },
          fields: fields.filter((field) => permitted[field]).map((field) => ({
            field, sourceValue: permitted[field]!, targetValue: target[field] || null,
            status: !target[field] ? "empty" : target[field] === permitted[field] ? "same" : "conflict",
          })),
          quotaImpact: { additionalPeople: 0, additionalMediaBytes: 0 } };
      }, true);
      if (result.code === 200) {
        return json(res, 200, { source: result.source, target: result.target,
          fields: result.fields, quotaImpact: result.quotaImpact });
      }
      return json(res, result.code, { error: result.code === 403
        ? "Доступно владельцу дерева" : "Связь не найдена" });
    }
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (req.method !== "GET" && req.method !== "PUT" && req.method !== "DELETE")
      return json(res, 405, { error: "Метод не поддерживается" });
    if (req.method !== "GET" &&
        !(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
      return json(res, 429, { error: "Слишком много запросов" });
    const archiveId = db.archiveId;
    if (req.method === "GET") {
      const result = await db.transaction(async () => {
        const pair = await linkedPair(detail[1],archiveId);
        if (!pair) return null;
        const ownPersonId = String(pair.left_archive_id === archiveId
          ? pair.left_person_id : pair.right_person_id);
        const own = await db.prepare("", "SELECT data FROM people WHERE archive_id=? AND id=?")
          .get(archiveId,ownPersonId);
        if (!own) return null;
        const available = scalarFields(own.data);
        const grants = await grantsFor(pair);
        const grant = (row: Row | undefined) => row ? {
          fields: scalarFields(row.fields), grantedAt: String(row.granted_at),
        } : null;
        return { available, previewToken: previewToken(available),
          outgoing: grant(grants.find((row) => row.grantor_archive_id === archiveId)),
          incoming: grant(grants.find((row) => row.grantor_archive_id !== archiveId)) };
      }, true);
      return result ? json(res, 200, result) : json(res, 404, { error: "Связь не найдена" });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const selected = selectedFields(body?.fields);
      if (!selected || typeof body?.previewToken !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.previewToken))
        return json(res, 400, { error: "Выберите доступные поля после просмотра карточки" });
      const result = await db.transaction(async () => {
        const preliminary = await linkedPair(detail[1],archiveId);
        if (!preliminary) return { code: 404, error: "Связь не найдена" };
        const ownPersonId = String(preliminary.left_archive_id === archiveId
          ? preliminary.left_person_id : preliminary.right_person_id);
        // Family edits lock people before refreshing the discovery projection.
        const own = await db.prepare("", "SELECT data FROM people WHERE archive_id=? AND id=? FOR SHARE")
          .get(archiveId,ownPersonId);
        if (!own) return { code: 404, error: "Связь не найдена" };
        const available = scalarFields(own.data);
        if (body.previewToken !== previewToken(available))
          return { code: 409, error: "Карточка изменилась. Проверьте поля ещё раз" };
        if (selected.some((field) => !available[field]))
          return { code: 409, error: "Выбранное поле больше недоступно" };
        const pair = await linkedPair(detail[1],archiveId,true);
        if (!pair || pairArgs(pair).some((value,index) => value !== pairArgs(preliminary)[index]))
          return { code: 404, error: "Связь не найдена" };
        const approved = await auth.currentUser(req);
        if (approved?.role !== "admin" || approved.approved !== true)
          return { code: 403, error: "Доступ отозван" };
        const snapshot: CardFields = {};
        for (const field of selected) snapshot[field] = available[field];
        await db.prepare("", `INSERT INTO discovery_linked_card_grants(
          left_archive_id,left_person_id,right_archive_id,right_person_id,
          grantor_archive_id,fields,granted_by) VALUES(?,?,?,?,?,?::jsonb,?)
          ON CONFLICT(left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id)
          DO UPDATE SET fields=EXCLUDED.fields,granted_by=EXCLUDED.granted_by,granted_at=now()
          WHERE discovery_linked_card_grants.fields IS DISTINCT FROM EXCLUDED.fields`)
          .run(...pairArgs(pair),archiveId,JSON.stringify(snapshot),approved.id);
        return { code: 200, fields: snapshot };
      });
      return "fields" in result ? json(res, 200, { fields: result.fields })
        : json(res, result.code, { error: result.error });
    }
    const result = await db.transaction(async () => {
      const pair = await linkedPair(detail[1],archiveId,true);
      if (!pair) return { code: 404, error: "Связь не найдена" };
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true)
        return { code: 403, error: "Доступ отозван" };
      await db.prepare("", `DELETE FROM discovery_linked_card_grants
        WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?
          AND grantor_archive_id=?`).run(...pairArgs(pair),archiveId);
      return { code: 200 };
    });
    return result.code === 200 ? json(res, 200, { shared: false })
      : json(res, result.code, { error: result.error });
  };
}
