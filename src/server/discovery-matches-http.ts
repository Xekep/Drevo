import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { createRequestLimiter, requestClientKey } from "./request-rate-limit.ts";

const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const archivePattern = /^[A-Za-z0-9-]{3,64}$/;
const matchPattern = /^[a-f0-9-]{36}$/;
type Row = Record<string, unknown>;

const projection = `SELECT m.id,m.left_archive_id,m.left_person_id,m.right_archive_id,m.right_person_id,
  m.initiated_by_archive_id,m.status,m.requested_at::text AS requested_at,
  m.responded_at::text AS responded_at,m.revoked_at::text AS revoked_at,
  l.name AS left_name,l.birth_surname AS left_birth_surname,
  l.birth_year AS left_birth_year,l.death_year AS left_death_year,
  l.birth_place AS left_birth_place,l.death_place AS left_death_place,
  r.name AS right_name,r.birth_surname AS right_birth_surname,
  r.birth_year AS right_birth_year,r.death_year AS right_death_year,
  r.birth_place AS right_birth_place,r.death_place AS right_death_place
  FROM discovery_match_requests m
  LEFT JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
  LEFT JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id`;

function person(row: Row, side: "left" | "right") {
  return {
    archiveId: String(row[`${side}_archive_id`]),
    id: String(row[`${side}_person_id`]),
    ...(row[`${side}_name`] ? { name: String(row[`${side}_name`]) } : {}),
    ...(row[`${side}_birth_surname`] ? { birthSurname: String(row[`${side}_birth_surname`]) } : {}),
    ...(row[`${side}_birth_year`] ? { birthYear: String(row[`${side}_birth_year`]) } : {}),
    ...(row[`${side}_death_year`] ? { deathYear: String(row[`${side}_death_year`]) } : {}),
    ...(row[`${side}_birth_place`] ? { birthPlace: String(row[`${side}_birth_place`]) } : {}),
    ...(row[`${side}_death_place`] ? { deathPlace: String(row[`${side}_death_place`]) } : {}),
  };
}

function match(row: Row) {
  return {
    id: String(row.id),
    status: String(row.status),
    initiatedByArchiveId: String(row.initiated_by_archive_id),
    requestedAt: String(row.requested_at),
    ...(row.responded_at ? { respondedAt: String(row.responded_at) } : {}),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    left: person(row, "left"),
    right: person(row, "right"),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (!req.headers["content-type"]?.startsWith("application/json")) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return null;
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function cursor(value: string | null): [string,string] | null {
  if (!value) return ["9999-12-31T23:59:59Z", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"];
  if (value.length > 300) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(parsed) && parsed.length === 2 &&
      typeof parsed[0] === "string" && !Number.isNaN(Date.parse(parsed[0])) &&
      typeof parsed[1] === "string" && matchPattern.test(parsed[1])
      ? parsed as [string,string] : null;
  } catch { return null; }
}

export function discoveryMatchesHttp({ archive, auth, publicOrigin }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const db = archive.db;
  const limiter = createRequestLimiter({ windowMs: 60_000, limit: 20 });
  const json = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const readMatch = (id: string) => db.prepare("", `${projection} WHERE m.id=?`).get(id);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const collection = url.pathname === "/api/discovery/matches";
    const ownPeople = url.pathname === "/api/discovery/matches/own-people";
    const detail = /^\/api\/discovery\/matches\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (!collection && !ownPeople && !detail) return false;
    if (db.kind !== "postgres" || !db.archiveId)
      return json(res, 501, { error: "Сопоставление деревьев доступно с PostgreSQL" });
    const user = await auth.currentUser(req);
    if (!user) return json(res, 401, { error: "Войдите в архив" });
    if (user.role !== "admin" || user.approved !== true)
      return json(res, 403, { error: "Сопоставлять людей может владелец дерева" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    const archiveId = db.archiveId;

    if (ownPeople) {
      if (req.method !== "GET") return json(res, 405, { error: "Ожидается GET" });
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length > 100) return json(res, 400, { error: "Слишком длинный запрос" });
      const words = query.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) || [];
      if (words.length > 8) return json(res, 400, { error: "Слишком длинный запрос" });
      const terms = words.map((word) => `${word}:*`).join(" & ");
      const base = `SELECT archive_id,person_id,name,birth_surname,birth_year,death_year,birth_place,death_place
        FROM discovery_people WHERE archive_id=?`;
      const rows = terms
        ? await db.prepare("", `${base} AND search_vector @@ to_tsquery('simple',?)
            ORDER BY name,person_id LIMIT 30`).all(archiveId,terms)
        : await db.prepare("", `${base} ORDER BY name,person_id LIMIT 30`).all(archiveId);
      return json(res, 200, { archiveId, people: rows.map((row) => ({
        archiveId: String(row.archive_id), id: String(row.person_id), name: String(row.name),
        ...(row.birth_surname ? { birthSurname: String(row.birth_surname) } : {}),
        ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
        ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
        ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
        ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
      })) });
    }

    if (collection && req.method === "GET") {
      const after = cursor(url.searchParams.get("cursor"));
      if (!after) return json(res, 400, { error: "Некорректная страница" });
      const rows = await db.prepare("", `${projection}
        WHERE (m.left_archive_id=? OR m.right_archive_id=?)
          AND (m.requested_at,m.id) < (?::timestamptz,?)
        ORDER BY m.requested_at DESC,m.id DESC LIMIT 31`).all(archiveId,archiveId,...after);
      const items = rows.slice(0, 30).map(match);
      const last = rows.length > 30 ? items.at(-1) : undefined;
      return json(res, 200, { archiveId, matches: items,
        nextCursor: last ? Buffer.from(JSON.stringify([last.requestedAt,last.id])).toString("base64url") : null });
    }
    if (collection && req.method === "POST") {
      if (!limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress)))
        return json(res, 429, { error: "Слишком много запросов" });
      const body = await readBody(req);
      const sourceId = body?.sourcePersonId;
      const targetArchiveId = body?.targetArchiveId;
      const targetId = body?.targetPersonId;
      if (typeof sourceId !== "string" || !idPattern.test(sourceId) ||
          typeof targetArchiveId !== "string" || !archivePattern.test(targetArchiveId) ||
          typeof targetId !== "string" || !idPattern.test(targetId) || targetArchiveId === archiveId)
        return json(res, 400, { error: "Выберите две опубликованные карточки из разных архивов" });
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true)
        return json(res, 403, { error: "Доступ отозван" });
      const pair = [[archiveId,sourceId],[targetArchiveId,targetId]].sort((a,b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
      const result = await db.transaction(async () => {
        const visible = await db.prepare("", `SELECT archive_id,person_id FROM discovery_people
          WHERE (archive_id=? AND person_id=?) OR (archive_id=? AND person_id=?)
          ORDER BY archive_id COLLATE "C",person_id COLLATE "C" FOR SHARE`)
          .all(archiveId,sourceId,targetArchiveId,targetId);
        if (visible.length !== 2) return null;
        await db.prepare("", `INSERT INTO discovery_match_requests(
          id,left_archive_id,left_person_id,right_archive_id,right_person_id,
          initiated_by_archive_id,requested_by)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(left_archive_id,left_person_id,right_archive_id,right_person_id)
          DO NOTHING`).run(randomUUID(),pair[0][0],pair[0][1],pair[1][0],pair[1][1],archiveId,approved.id);
        return await db.prepare("", `${projection} WHERE m.left_archive_id=? AND m.left_person_id=?
          AND m.right_archive_id=? AND m.right_person_id=?`).get(pair[0][0],pair[0][1],pair[1][0],pair[1][1]);
      });
      return result ? json(res, 200, { match: match(result) })
        : json(res, 409, { error: "Одна из карточек больше не открыта для поиска" });
    }
    if (detail && req.method === "PATCH") {
      const body = await readBody(req);
      const decision = body?.decision;
      if (decision !== "accept" && decision !== "reject" && decision !== "revoke")
        return json(res, 400, { error: "Некорректное решение" });
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true)
        return json(res, 403, { error: "Доступ отозван" });
      const result = await db.transaction(async () => {
        if (decision === "accept") {
          // Publication deletion also locks its row before the revocation
          // trigger locks this request. Keep the same order to avoid deadlock.
          const candidate = await db.prepare("", "SELECT * FROM discovery_match_requests WHERE id=?").get(detail[1]);
          if (!candidate) return { code: 404, error: "Запрос не найден" };
          const visible = await db.prepare("", `SELECT archive_id,person_id FROM discovery_people
            WHERE (archive_id=? AND person_id=?) OR (archive_id=? AND person_id=?)
            ORDER BY archive_id COLLATE "C",person_id COLLATE "C" FOR SHARE`)
            .all(String(candidate.left_archive_id),String(candidate.left_person_id),
              String(candidate.right_archive_id),String(candidate.right_person_id));
          if (visible.length !== 2) return { code: 409, error: "Карточка снята с поиска" };
        }
        const row = await db.prepare("", `SELECT * FROM discovery_match_requests WHERE id=? FOR UPDATE`).get(detail[1]);
        if (!row) return { code: 404, error: "Запрос не найден" };
        if (row.left_archive_id !== archiveId && row.right_archive_id !== archiveId)
          return { code: 404, error: "Запрос не найден" };
        if (decision !== "revoke" && row.initiated_by_archive_id === archiveId)
          return { code: 403, error: "Подтвердить должна другая сторона" };
        if (decision === "accept" && row.status === "linked" ||
            decision === "reject" && row.status === "rejected" ||
            decision === "revoke" && row.status === "revoked")
          return { code: 200, row: await readMatch(detail[1]) };
        if (decision !== "revoke" && row.status !== "pending" ||
            decision === "revoke" && row.status !== "pending" && row.status !== "linked")
          return { code: 409, error: "Решение уже изменено" };
        await db.prepare("", `UPDATE discovery_match_requests SET status=?,
          responded_by=CASE WHEN ?='revoke' THEN responded_by ELSE ? END,
          responded_at=CASE WHEN ?='revoke' THEN responded_at ELSE now() END,
          revoked_by=CASE WHEN ?='revoke' THEN ? ELSE revoked_by END,
          revoked_at=CASE WHEN ?='revoke' THEN now() ELSE revoked_at END
          WHERE id=?`).run(decision === "accept" ? "linked" : decision === "reject" ? "rejected" : "revoked",
          decision,approved.id,decision,decision,approved.id,decision,detail[1]);
        return { code: 200, row: await readMatch(detail[1]) };
      });
      return "row" in result ? json(res, 200, { match: match(result.row!) })
        : json(res, result.code, { error: result.error });
    }
    return json(res, 405, { error: "Метод не поддерживается" });
  };
}
