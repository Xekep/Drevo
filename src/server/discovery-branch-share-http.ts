import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import type { Family } from "../domain/types.ts";

type Row = Record<string, unknown>;
type Relation = "parent" | "child" | "spouse";
type Member = { id: string; relation: Relation; name: string; birthYear?: string;
  deathYear?: string; birthPlace?: string; deathPlace?: string; publicationVersion: string };
const route = /^\/api\/discovery\/matches\/([a-f0-9-]{36})\/branch-share$/;
const maxMembers = 20;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return null;
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : null;
  } catch { return null; }
}

function pairArgs(pair: Row) {
  return [String(pair.left_archive_id), String(pair.left_person_id),
    String(pair.right_archive_id), String(pair.right_person_id)];
}

function directRelations(family: Family, rootId: string): Map<string, Relation> {
  const root = family.people.find((person) => person.id === rootId);
  const result = new Map<string, Relation>();
  if (!root) return result;
  for (const id of root.parents) if (id !== rootId) result.set(id, "parent");
  for (const id of root.spouses) if (id !== rootId && !result.has(id)) result.set(id, "spouse");
  for (const person of family.people)
    if (person.id !== rootId && person.parents.includes(rootId) && !result.has(person.id))
      result.set(person.id, "child");
  return result;
}

function listed(row: Row, relation: Relation): Member {
  return {
    id: String(row.person_id), relation, name: String(row.name),
    ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
    ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
    ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
    ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
    publicationVersion: String(row.publication_version),
  };
}

/** Only a mutual opt-in on this exact linked pair exposes published direct relatives. */
export function discoveryBranchShareHttp({ archive, auth, publicOrigin }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const db = archive.db;
  const limiter = createSharedRequestLimiter(db, "discovery-branch-share", { windowMs: 60_000, limit: 20 });
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
     ${lock ? "FOR UPDATE OF m FOR SHARE OF p" : ""}`).get(id, archiveId, archiveId);
  const ownRoot = (pair: Row, archiveId: string) => String(
    pair.left_archive_id === archiveId ? pair.left_person_id : pair.right_person_id);
  const availableFor = async (pair: Row, archiveId: string) => {
    const snapshot = await archive.read();
    const relations = directRelations(snapshot.family, ownRoot(pair, archiveId));
    const ids = [...relations.keys()].sort();
    const rows = ids.length ? await db.prepare("", `SELECT person_id,name,birth_year,death_year,
      birth_place,death_place,publication_version FROM discovery_people
      WHERE archive_id=? AND person_id IN (SELECT jsonb_array_elements_text(?::jsonb))
      ORDER BY person_id LIMIT 51`).all(archiveId, JSON.stringify(ids)) : [];
    const available = rows.slice(0, 50).map((row) => listed(row, relations.get(String(row.person_id))!));
    const previewToken = createHash("sha256").update(JSON.stringify({
      archiveId, pair: pairArgs(pair), revision: snapshot.revision, available,
    })).digest("hex");
    return { available, truncated: rows.length > 50, previewToken };
  };
  const grantsFor = (pair: Row) => db.prepare("", `SELECT grantor_archive_id FROM discovery_branch_grants
    WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?`)
    .all(...pairArgs(pair));
  const isOwner = async (archiveId: string, userId: string, lock = false) => Boolean(
    await db.prepare("", `SELECT 1 FROM archive_owners WHERE archive_id=? AND user_id=?
      ${lock ? "FOR SHARE" : ""}`).get(archiveId, userId));
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const detail = route.exec(url.pathname);
    if (!detail) return false;
    if (db.kind !== "postgres" || !db.archiveId)
      return json(res, 501, { error: "Просмотр ветки доступен с PostgreSQL" });
    const user = await auth.currentUser(req);
    if (!user) return json(res, 401, { error: "Войдите в архив" });
    if (user.role !== "admin" || user.approved !== true)
      return json(res, 403, { error: "Доступно владельцу дерева" });
    if (!(await isOwner(db.archiveId, user.id)))
      return json(res, 403, { error: "Доступно владельцу дерева" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (req.method !== "GET" && req.method !== "PUT" && req.method !== "DELETE")
      return json(res, 405, { error: "Метод не поддерживается" });
    if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
      return json(res, 429, { error: "Слишком много запросов" });
    const archiveId = db.archiveId;
    if (req.method === "GET") {
      const result = await db.transaction(async () => {
        const pair = await linkedPair(detail[1], archiveId);
        if (!pair) return null;
        const preview = await availableFor(pair, archiveId);
        const grants = await grantsFor(pair);
        const ownReady = grants.some((row) => row.grantor_archive_id === archiveId);
        const otherReady = grants.some((row) => row.grantor_archive_id !== archiveId);
        const ownRows = ownReady ? await db.prepare("", `SELECT person_id FROM discovery_branch_members
          WHERE left_archive_id=? AND left_person_id=? AND right_archive_id=? AND right_person_id=?
            AND grantor_archive_id=?`).all(...pairArgs(pair), archiveId) : [];
        const outgoingIds = ownRows.map((row) => String(row.person_id));
        const incoming = ownReady && otherReady ? await db.prepare("", `SELECT
          p.person_id,p.name,p.birth_year,p.death_year,p.birth_place,p.death_place,
          p.publication_version,b.relation FROM discovery_branch_members b
          JOIN discovery_people p ON p.archive_id=b.grantor_archive_id AND p.person_id=b.person_id
          WHERE b.left_archive_id=? AND b.left_person_id=? AND b.right_archive_id=?
            AND b.right_person_id=? AND b.grantor_archive_id<>?
          ORDER BY p.person_id LIMIT ?`).all(...pairArgs(pair), archiveId, maxMembers) : [];
        return { ...preview, ownReady, otherReady, outgoingIds,
          incoming: incoming.map((row) => listed(row, String(row.relation) as Relation)) };
      }, true);
      return result ? json(res, 200, result) : json(res, 404, { error: "Связь не найдена" });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const ids = body?.personIds;
      if (!Array.isArray(ids) || ids.length > maxMembers ||
          ids.some((id) => typeof id !== "string" || id.length > 100) ||
          new Set(ids).size !== ids.length ||
          typeof body?.previewToken !== "string" || !/^[0-9a-f]{64}$/.test(body.previewToken))
        return json(res, 400, { error: "Выберите людей после просмотра ветки" });
      const result = await db.transaction(async () => {
        const pair = await linkedPair(detail[1], archiveId);
        if (!pair) return { code: 404, error: "Связь не найдена" };
        const selectedIds = ids as string[];
        const lockIds = [ownRoot(pair, archiveId), ...selectedIds];
        await db.prepare("", `SELECT id FROM people WHERE archive_id=?
          AND id IN (${lockIds.map(() => "?").join(",")}) FOR SHARE`).all(archiveId, ...lockIds);
        const preview = await availableFor(pair, archiveId);
        if (preview.previewToken !== body.previewToken ||
            selectedIds.some((id) => !preview.available.some((person) => person.id === id)))
          return { code: 409, error: "Ветка изменилась. Проверьте выбранных людей ещё раз" };
        const locked = await linkedPair(detail[1], archiveId, true);
        if (!locked || pairArgs(locked).some((value, index) => value !== pairArgs(pair)[index]))
          return { code: 404, error: "Связь не найдена" };
        const approved = await auth.currentUser(req);
        if (approved?.role !== "admin" || approved.approved !== true || approved.id !== user.id)
          return { code: 403, error: "Доступ отозван" };
        if (!(await isOwner(archiveId, approved.id, true)))
          return { code: 403, error: "Доступ отозван" };
        await db.prepare("", `DELETE FROM discovery_branch_grants WHERE left_archive_id=?
          AND left_person_id=? AND right_archive_id=? AND right_person_id=?
          AND grantor_archive_id=?`).run(...pairArgs(pair), archiveId);
        await db.prepare("", `INSERT INTO discovery_branch_grants(left_archive_id,left_person_id,
          right_archive_id,right_person_id,grantor_archive_id,granted_by)
          VALUES(?,?,?,?,?,?)`).run(...pairArgs(pair), archiveId, approved.id);
        for (const id of selectedIds) {
          const person = preview.available.find((item) => item.id === id)!;
          await db.prepare("", `INSERT INTO discovery_branch_members(left_archive_id,left_person_id,
            right_archive_id,right_person_id,grantor_archive_id,person_id,relation)
            VALUES(?,?,?,?,?,?,?)`).run(...pairArgs(pair), archiveId, id, person.relation);
        }
        return { code: 200 };
      });
      return result.code === 200 ? json(res, 200, { shared: true })
        : json(res, result.code, { error: result.error });
    }
    const result = await db.transaction(async () => {
      const pair = await linkedPair(detail[1], archiveId, true);
      if (!pair) return { code: 404, error: "Связь не найдена" };
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true || approved.id !== user.id)
        return { code: 403, error: "Доступ отозван" };
      if (!(await isOwner(archiveId, approved.id, true)))
        return { code: 403, error: "Доступ отозван" };
      await db.prepare("", `DELETE FROM discovery_branch_grants WHERE left_archive_id=?
        AND left_person_id=? AND right_archive_id=? AND right_person_id=?
        AND grantor_archive_id=?`).run(...pairArgs(pair), archiveId);
      return { code: 200 };
    });
    return result.code === 200 ? json(res, 200, { shared: false })
      : json(res, result.code, { error: result.error });
  };
}
