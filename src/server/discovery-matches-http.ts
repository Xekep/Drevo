import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { decodeCandidatePageCursor, discoveryCandidatePage,
  candidateRelativeClueLimit, candidateRelativeRowLimit } from "./discovery-candidate-pages.ts";
import { publicPersonId } from "./public-person-id.ts";
import { AccountSessionBusy } from "./account-session-guard.ts";
import { lockDiscoveryOwnerReadAccess } from "./discovery-owner-read-access.ts";

const archivePattern = /^[A-Za-z0-9-]{3,64}$/;
const matchPattern = /^[a-f0-9-]{36}$/;
type Row = Record<string, unknown>;

const projection = `SELECT m.id,m.left_archive_id,m.left_person_id,m.right_archive_id,m.right_person_id,
  m.initiated_by_archive_id,m.status,m.reason,m.request_review_token,
  m.decision_review_token,m.requested_at::text AS requested_at,
  m.responded_at::text AS responded_at,m.revoked_at::text AS revoked_at,
  l.name AS left_name,l.birth_surname AS left_birth_surname,
  l.birth_year AS left_birth_year,l.death_year AS left_death_year,
  l.birth_place AS left_birth_place,l.death_place AS left_death_place,
  l.publication_version AS left_publication_version,
  r.name AS right_name,r.birth_surname AS right_birth_surname,
  r.birth_year AS right_birth_year,r.death_year AS right_death_year,
  r.birth_place AS right_birth_place,r.death_place AS right_death_place,
  r.publication_version AS right_publication_version
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
  const token = reviewToken(row);
  return {
    id: String(row.id),
    status: String(row.status),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    initiatedByArchiveId: String(row.initiated_by_archive_id),
    requestedAt: String(row.requested_at),
    ...(row.responded_at ? { respondedAt: String(row.responded_at) } : {}),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    left: person(row, "left"),
    right: person(row, "right"),
    ...(token ? { reviewToken: token } : {}),
    ...(row.status === "pending" && row.request_review_token && token
      ? { changedSinceRequest: row.request_review_token !== token } : {}),
  };
}

/** Changes whenever either currently published identity or consented field changes. */
function reviewToken(row: Row): string | null {
  if (row.left_name == null || row.right_name == null) return null;
  const fields = ["left_archive_id","left_person_id","right_archive_id","right_person_id",
    "left_name","left_birth_surname","left_birth_year","left_death_year",
    "left_birth_place","left_death_place","left_publication_version",
    "right_name","right_birth_surname","right_birth_year","right_death_year",
    "right_birth_place","right_death_place","right_publication_version"];
  return createHash("sha256").update(JSON.stringify(fields.map((field) => row[field] ?? null)))
    .digest("hex");
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

export function discoveryMatchesHttp({ archive, auth, publicOrigin,
  beforeCandidateDelivery, beforeCandidateResponse,
  beforeMatchListDelivery, beforeIgnoredArchivesDelivery, beforeMutationDelivery,
  beforeOwnPersonAccessLock, beforeOwnPersonResponse }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  beforeCandidateDelivery?: () => Promise<void>;
  beforeCandidateResponse?: () => Promise<void>;
  beforeMatchListDelivery?: () => Promise<void>;
  beforeIgnoredArchivesDelivery?: () => Promise<void>;
  beforeMutationDelivery?: () => Promise<void>;
  beforeOwnPersonAccessLock?: () => Promise<void>;
  beforeOwnPersonResponse?: () => Promise<void>;
}) {
  const db = archive.db;
  const limiter = createSharedRequestLimiter(db, "discovery-matches", { windowMs: 60_000, limit: 20 });
  const json = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const deliverLocked = async (res: ServerResponse, value: unknown) => {
    const delivered = finished(res, { cleanup: true });
    const timeout = setTimeout(() => res.destroy(), 5_000);
    timeout.unref();
    try {
      json(res, 200, value);
      await delivered;
    } catch (error) {
      const disconnected = res.destroyed;
      res.destroy();
      await delivered.catch(() => {});
      if (!disconnected) throw error;
    } finally { clearTimeout(timeout); }
  };
  const readMatch = (id: string) => db.prepare("", `${projection} WHERE m.id=?`).get(id);
  const hideRejectedCandidate = (row: Row, archiveId: string, actorId: string) => {
    const ownIsLeft = row.left_archive_id === archiveId;
    return db.prepare("", `INSERT INTO discovery_ignored_candidates(
      archive_id,source_person_id,target_archive_id,target_person_id,ignored_by)
      VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`).run(archiveId,
      String(ownIsLeft ? row.left_person_id : row.right_person_id),
      String(ownIsLeft ? row.right_archive_id : row.left_archive_id),
      String(ownIsLeft ? row.right_person_id : row.left_person_id), actorId);
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const collection = url.pathname === "/api/discovery/matches";
    const ownPeople = url.pathname === "/api/discovery/matches/own-people";
    const candidates = url.pathname === "/api/discovery/matches/candidates";
    const relativeConsents = url.pathname === "/api/discovery/matches/relative-consents";
    const ignoredCandidates = url.pathname === "/api/discovery/matches/ignored";
    const ignoredArchives = url.pathname === "/api/discovery/matches/ignored-archives";
    const detail = /^\/api\/discovery\/matches\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (!collection && !ownPeople && !candidates && !relativeConsents && !ignoredCandidates && !ignoredArchives && !detail) return false;
    if (db.kind !== "postgres" || !db.archiveId)
      return json(res, 501, { error: "Сопоставление деревьев доступно с PostgreSQL" });
    const archiveId = db.archiveId;
    const isOwner = async (userId: string, lock = false) => !!await db.prepare("",
      `SELECT 1 FROM archive_owners WHERE archive_id=? AND user_id=? ${lock ? "FOR SHARE" : ""}`,
    ).get(archiveId, userId);
    const user = await auth.currentUser(req);
    if (!user) return json(res, 401, { error: "Войдите в архив" });
    if (user.role !== "admin" || user.approved !== true || !await isOwner(user.id))
      return json(res, 403, { error: "Сопоставлять людей может владелец дерева" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    const deliverMutationMatch = (initial: Row) => db.transaction(async () => {
      if (!await isOwner(user.id,true))
        return json(res, 403, { error: "Доступ владельца отозван" });
      // Unpublishing takes the publication row before its trigger changes the
      // match request. Keep that order, including for a committed mutation.
      const expected = (["left","right"] as const).flatMap((side) =>
        initial[`${side}_name`] == null ? [] : [{
          archive_id: String(initial[`${side}_archive_id`]),
          person_id: String(initial[`${side}_person_id`]),
        }]);
      if (expected.length) {
        const locked = await db.prepare("", `SELECT d.archive_id,d.person_id
          FROM discovery_people d JOIN jsonb_to_recordset(?::jsonb)
            AS e(archive_id text,person_id text)
            ON e.archive_id=d.archive_id AND e.person_id=d.person_id
          ORDER BY d.archive_id COLLATE "C",d.person_id COLLATE "C" FOR SHARE OF d`)
          .all(JSON.stringify(expected));
        if (locked.length !== expected.length)
          return json(res, 409, { error: "Публикации изменились. Обновите сопоставление." });
      }
      const lockedRequest = await db.prepare("", `SELECT id FROM discovery_match_requests
        WHERE id=? FOR SHARE`).get(String(initial.id));
      if (!lockedRequest)
        return json(res, 409, { error: "Сопоставление изменилось. Обновите список." });
      const current = await readMatch(String(initial.id));
      if (!current || JSON.stringify(match(current)) !== JSON.stringify(match(initial)))
        return json(res, 409, { error: "Сопоставление изменилось. Обновите список." });
      await beforeMutationDelivery?.();
      await deliverLocked(res, { match: match(current) });
      return true;
    });

    if (relativeConsents) {
      if (req.method !== "GET" && req.method !== "POST")
        return json(res, 405, { error: "Ожидается GET или POST" });
      const body = req.method === "POST" ? await readBody(req) : null;
      const personId = req.method === "GET" ? url.searchParams.get("personId") : body?.personId;
      const relationId = body?.relationId;
      const enabled = body?.enabled;
      if (typeof personId !== "string" || !publicPersonId(personId) ||
          (req.method === "POST" && (typeof relationId !== "string" ||
            !publicPersonId(relationId) || typeof enabled !== "boolean")))
        return json(res, 400, { error: "Некорректная карточка или связь" });
      const session = auth.local ? null : await auth.accountSession(req);
      const relationsSql = `SELECT r.id AS relation_id,other.person_id AS relative_person_id,
        other.name AS relative_name,CASE WHEN r.type='spouse' THEN 'spouse'
          WHEN r.source=? THEN 'child' ELSE 'parent' END AS kind,
        c.relation_id IS NOT NULL AS enabled
        FROM relations r JOIN discovery_people other ON other.archive_id=r.archive_id
          AND other.person_id=CASE WHEN r.source=? THEN r.target ELSE r.source END
        LEFT JOIN discovery_relative_consents c ON c.archive_id=r.archive_id
          AND c.person_id=? AND c.relation_id=r.id
        WHERE r.archive_id=? AND r.type IN ('parent','spouse')
          AND (r.source=? OR r.target=?) ORDER BY r.id`;
      const args = [personId,personId,personId,archiveId,personId,personId];
      const result = await db.transaction(async () => {
        if (!await lockDiscoveryOwnerReadAccess(db,auth.local,session,user) ||
            !await isOwner(user.id,true)) return { status: 403 };
        if (!await db.prepare("", `SELECT 1 FROM discovery_people
          WHERE archive_id=? AND person_id=? ${req.method === "POST" ? "FOR UPDATE" : "FOR SHARE"}`)
          .get(archiveId,personId))
          return { status: 404 };
        if (req.method === "GET") {
          const rows = await db.prepare("", relationsSql).all(...args);
          await deliverLocked(res, { relatives: rows.map((row) => ({
            relationId: String(row.relation_id), personId: String(row.relative_person_id),
            name: String(row.relative_name), kind: String(row.kind), enabled: row.enabled === true,
          })) });
          return { status: 200 };
        }
        const eligible = (await db.prepare("", relationsSql).all(...args))
          .find((row) => row.relation_id === relationId);
        if (!eligible) return { status: 404 };
        if (enabled) {
          await db.prepare("", `INSERT INTO discovery_relative_consents
            (archive_id,person_id,relation_id,relative_person_id,kind,relative_name)
            VALUES(?,?,?,?,?,?) ON CONFLICT (archive_id,person_id,relation_id) DO UPDATE SET
              relative_person_id=excluded.relative_person_id,kind=excluded.kind,
              relative_name=excluded.relative_name`).run(archiveId,personId,String(relationId),
                String(eligible.relative_person_id),String(eligible.kind),
                String(eligible.relative_name));
        } else {
          await db.prepare("", `DELETE FROM discovery_relative_consents
            WHERE archive_id=? AND person_id=? AND relation_id=?`)
            .run(archiveId,personId,String(relationId));
        }
        return { status: 200 };
      }).catch((error) => {
        if ((error as { code?: string }).code === "55P03" || error instanceof AccountSessionBusy)
          return { status: 409 };
        throw error;
      });
      if (result.status === 200) return req.method === "GET" ? true
        : json(res, 200, { saved: true });
      return json(res, result.status, { error: result.status === 403
        ? "Доступ владельца отозван" : result.status === 404
          ? "Связь или публикация больше не доступны" : "Данные заняты. Повторите запрос" });
    }

    if (ignoredArchives) {
      if (req.method === "GET") {
        const page = Number(url.searchParams.get("page") || "0");
        if (!Number.isInteger(page) || page < 0 || page > 1000)
          return json(res, 400, { error: "Некорректная страница" });
        const pageSql = `SELECT i.target_archive_id,d.person_id AS example_person_id,
          d.name AS example_name
          FROM discovery_ignored_archives i LEFT JOIN LATERAL (
            SELECT person_id,name FROM discovery_people
            WHERE archive_id=i.target_archive_id ORDER BY name,person_id LIMIT 1
          ) d ON true WHERE i.archive_id=?
          ORDER BY i.ignored_at DESC,i.target_archive_id LIMIT 31 OFFSET ?`;
        const preliminary = await db.prepare("", pageSql).all(archiveId,page*30);
        const examples = preliminary.flatMap((row) => row.example_person_id ? [{
          archive_id: String(row.target_archive_id),
          person_id: String(row.example_person_id),
        }] : []);
        const result = await db.transaction(async () => {
          if (!await isOwner(user.id,true)) return 403;
          if (examples.length) {
            const locked = await db.prepare("", `SELECT d.archive_id,d.person_id
              FROM discovery_people d JOIN jsonb_to_recordset(?::jsonb)
                AS e(archive_id text,person_id text)
                ON e.archive_id=d.archive_id AND e.person_id=d.person_id
              ORDER BY d.archive_id COLLATE "C",d.person_id COLLATE "C" FOR SHARE OF d`)
              .all(JSON.stringify(examples));
            if (locked.length !== examples.length) return 409;
          }
          const rows = await db.prepare("", pageSql).all(archiveId,page*30);
          if (rows.length !== preliminary.length || rows.some((row,index) =>
            row.target_archive_id !== preliminary[index].target_archive_id ||
            row.example_person_id !== preliminary[index].example_person_id)) return 409;
          await beforeIgnoredArchivesDelivery?.();
          await deliverLocked(res, { archives: rows.slice(0,30).map((row) => ({
            archiveId: String(row.target_archive_id),
            ...(row.example_name ? { exampleName: String(row.example_name) } : {}),
          })), nextPage: rows.length > 30 ? page + 1 : null });
          return 200;
        });
        return result === 200 ? true : json(res, result, { error: result === 403
          ? "Доступ владельца отозван" : "Публикации изменились. Обновите список." });
      }
      if (req.method !== "POST") return json(res, 405, { error: "Ожидается GET или POST" });
      if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
        return json(res, 429, { error: "Слишком много запросов" });
      const body = await readBody(req);
      const targetArchiveId = body?.targetArchiveId;
      const ignored = body?.ignored;
      if (typeof targetArchiveId !== "string" || !archivePattern.test(targetArchiveId) ||
          targetArchiveId === archiveId || typeof ignored !== "boolean")
        return json(res, 400, { error: "Выберите другое опубликованное дерево" });
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true || !await isOwner(approved.id))
        return json(res, 403, { error: "Доступ отозван" });
      const result = await db.transaction(async () => {
        if (!await isOwner(approved.id, true)) return { code: 403, error: "Доступ владельца отозван" };
        if (!ignored) {
          await db.prepare("", `DELETE FROM discovery_ignored_archives
            WHERE archive_id=? AND target_archive_id=?`).run(archiveId,targetArchiveId);
          return { code: 200, ignored: false };
        }
        const visible = await db.prepare("", `SELECT 1 FROM discovery_people
          WHERE archive_id=? LIMIT 1`).get(targetArchiveId);
        if (!visible) return { code: 409, error: "В этом дереве больше нет опубликованных карточек" };
        await db.prepare("", `INSERT INTO discovery_ignored_archives(
          archive_id,target_archive_id,ignored_by) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
          .run(archiveId,targetArchiveId,approved.id);
        return { code: 200, ignored: true };
      });
      return json(res, result.code, "error" in result ? { error: result.error } : { ignored: result.ignored });
    }

    if (ignoredCandidates) {
      if (req.method !== "POST") return json(res, 405, { error: "Ожидается POST" });
      if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
        return json(res, 429, { error: "Слишком много запросов" });
      const body = await readBody(req);
      const sourceId = body?.sourcePersonId;
      const targetArchiveId = body?.targetArchiveId;
      const targetId = body?.targetPersonId;
      const ignored = body?.ignored;
      if (!publicPersonId(sourceId) ||
          typeof targetArchiveId !== "string" || !archivePattern.test(targetArchiveId) ||
          !publicPersonId(targetId) ||
          targetArchiveId === archiveId || typeof ignored !== "boolean")
        return json(res, 400, { error: "Выберите две опубликованные карточки из разных архивов" });
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true || !await isOwner(approved.id))
        return json(res, 403, { error: "Доступ отозван" });
      const result = await db.transaction(async () => {
        if (!await isOwner(approved.id, true)) return undefined;
        if (!ignored) {
          await db.prepare("", `DELETE FROM discovery_ignored_candidates WHERE archive_id=?
            AND source_person_id=? AND target_archive_id=? AND target_person_id=?`)
            .run(archiveId,sourceId,targetArchiveId,targetId);
          return true;
        }
        const visible = await db.prepare("", `SELECT archive_id,person_id FROM discovery_people
          WHERE (archive_id=? AND person_id=?) OR (archive_id=? AND person_id=?)
          ORDER BY archive_id COLLATE "C",person_id COLLATE "C" FOR SHARE`)
          .all(archiveId,sourceId,targetArchiveId,targetId);
        if (visible.length !== 2) return false;
        await db.prepare("", `INSERT INTO discovery_ignored_candidates(
          archive_id,source_person_id,target_archive_id,target_person_id,ignored_by)
          VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .run(archiveId,sourceId,targetArchiveId,targetId,approved.id);
        return true;
      });
      return result === undefined
        ? json(res, 403, { error: "Доступ владельца отозван" })
        : result ? json(res, 200, { ignored })
        : json(res, 409, { error: "Одна из карточек больше не опубликована" });
    }

    if (candidates) {
      if (req.method !== "GET") return json(res, 405, { error: "Ожидается GET" });
      if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
        return json(res, 429, { error: "Слишком много запросов" });
      const sourceId = url.searchParams.get("sourcePersonId") || "";
      if (!publicPersonId(sourceId)) return json(res, 400, { error: "Выберите опубликованную карточку" });
      const after = decodeCandidatePageCursor(url.searchParams.get("cursor"));
      if (after === false) return json(res, 400, { error: "Некорректная страница подсказок" });
      const columns = `archive_id,person_id,name,surname_part,given_part,birth_surname,
        birth_year,death_year,birth_place,death_place,
        publication_version::text AS publication_version,xmin::text AS row_version,
        replace(lower(coalesce(nullif(given_part,''),split_part(name,' ',2))),
          'ё','е') AS given_key,
        replace(lower(coalesce(nullif(surname_part,''),split_part(name,' ',1))),
          'ё','е') AS surname_key,
        birth_surname_normalized AS birth_surname_key`;
      const sourceRow = await db.prepare("", `SELECT ${columns} FROM discovery_people
        WHERE archive_id=? AND person_id=?`).get(archiveId,sourceId);
      if (!sourceRow) return json(res, 404, { error: "Карточка больше не опубликована" });
      const session = auth.local ? null : await auth.accountSession(req);
      const page = await discoveryCandidatePage(db, { archiveId,sourceId,sourceRow,
        ignored: url.searchParams.get("ignored") === "1",cursor: after }).catch((error) => {
        if ((error as { code?: string }).code === "57014") return null;
        throw error;
      });
      if (!page) return json(res, 503, { approximate: true, partial: true,
        error: "Широкий поиск занял слишком долго. Уточните опубликованные сведения и повторите запрос." });
      if (page.kind === "stale")
        return json(res, 409, { error: "Публикация или согласия изменились. Обновите подсказки." });
      if (page.kind === "refine")
        return json(res, 422, { refineRequired: true,
          relativeConsentLimit: candidateRelativeClueLimit,
          relativeConsentRowLimit: candidateRelativeRowLimit,
          error: `Выберите не более ${candidateRelativeClueLimit} разных и ${candidateRelativeRowLimit} общих подсказок о близких родственниках в настройках публикации.` });
      const { rows,relatives, candidates: ranked,nextCursor,approximate,partial } = page;
      await beforeCandidateDelivery?.();
      const expectedPeople = [sourceRow,...rows].map((row) => ({
        archive_id: String(row.archive_id), person_id: String(row.person_id),
        publication_version: String(row.publication_version), row_version: String(row.row_version),
      }));
      const result = await db.transaction(async () => {
        if (!await lockDiscoveryOwnerReadAccess(db,auth.local,session,user)) return 403;
        // Publication writes check owner access before touching published rows.
        // Keep that order, and hold ownership through response delivery so a
        // transfer cannot complete before a former owner receives suggestions.
        if (!await db.prepare("", `SELECT 1 FROM archive_owners
          WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`).get(archiveId,user.id)) return 403;
        // Withdrawal locks a published row before its projection disappears.
        // Hold the source and displayed cards through response completion.
        // A published relative-name update may lock its row before the focal
        // consent row; fail fast instead of waiting while holding earlier rows.
        const locked = await db.prepare("", `SELECT d.archive_id,d.person_id
          FROM discovery_people d JOIN jsonb_to_recordset(?::jsonb)
            AS e(archive_id text,person_id text)
            ON e.archive_id=d.archive_id AND e.person_id=d.person_id
          ORDER BY d.archive_id COLLATE "C",d.person_id COLLATE "C" FOR SHARE OF d NOWAIT`)
          .all(JSON.stringify(expectedPeople));
        if (locked.length !== expectedPeople.length) return 409;
        // Every consent UPDATE/DELETE takes its focal discovery row FOR UPDATE
        // in the trigger. The focal rows above stay SHARE-locked through send.
        const currentRelatives = await db.prepare("", `SELECT c.archive_id,c.person_id,
          c.relation_id,c.kind,c.relative_name,c.xmin::text AS row_version
          FROM discovery_relative_consents c JOIN jsonb_to_recordset(?::jsonb)
            AS p(archive_id text,person_id text)
            ON p.archive_id=c.archive_id AND p.person_id=c.person_id
          ORDER BY c.archive_id COLLATE "C",c.person_id COLLATE "C",
            c.relation_id COLLATE "C"`)
          .all(JSON.stringify(relatives.people));
        if (JSON.stringify(currentRelatives) !== JSON.stringify(relatives.signals))
          return 409;
        // Other publications may move between pages. The selected published
        // cards themselves must still be the same projection before delivery.
        const current = await db.prepare("", `WITH expected_people AS (
          SELECT * FROM jsonb_to_recordset(?::jsonb) AS e(
            archive_id text,person_id text,publication_version text,row_version text)
        ) SELECT
          (SELECT count(*) FROM expected_people e JOIN discovery_people d
            ON d.archive_id=e.archive_id AND d.person_id=e.person_id
            AND d.publication_version::text=e.publication_version
            AND d.xmin::text=e.row_version) AS people_count`)
          .get(JSON.stringify(expectedPeople));
        if (Number(current?.people_count) !== expectedPeople.length) return 409;
        await beforeCandidateResponse?.();
        await deliverLocked(res, { candidates: ranked, truncated: nextCursor !== null,
          nextCursor, approximate, partial });
        return 200;
      }).catch((error) => {
        if ((error as { code?: string }).code === "55P03" || error instanceof AccountSessionBusy)
          return 409;
        throw error;
      });
      return result === 200 ? true
        : json(res, result, { error: result === 403 ? "Доступ владельца отозван" :
          "Опубликованные карточки изменились. Обновите подсказки." });
    }

    if (ownPeople) {
      if (req.method !== "GET") return json(res, 405, { error: "Ожидается GET" });
      const exactId = url.searchParams.get("personId");
      if (exactId !== null && !publicPersonId(exactId))
        return json(res, 400, { error: "Некорректная карточка" });
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length > 100) return json(res, 400, { error: "Слишком длинный запрос" });
      const words = query.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) || [];
      if (words.length > 8) return json(res, 400, { error: "Слишком длинный запрос" });
      const terms = words.map((word) => `${word}:*`).join(" & ");
      const base = `SELECT archive_id,person_id,name,birth_surname,birth_year,death_year,birth_place,death_place
        FROM discovery_people WHERE archive_id=?`;
      const ownPerson = (row: Row) => ({
        archiveId: String(row.archive_id), id: String(row.person_id), name: String(row.name),
        ...(row.birth_surname ? { birthSurname: String(row.birth_surname) } : {}),
        ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
        ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
        ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
        ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
      });
      if (exactId !== null) {
        const session = await auth.accountSession(req);
        await beforeOwnPersonAccessLock?.();
        const result = await db.transaction(async () => {
          if (!await lockDiscoveryOwnerReadAccess(db, auth.local, session, user) ||
              !await isOwner(user.id,true)) return 403;
          const row = await db.prepare("", `${base} AND person_id=? FOR SHARE`).get(archiveId,exactId);
          if (!row) return 404;
          await beforeOwnPersonResponse?.();
          await deliverLocked(res, { archiveId, people: [ownPerson(row)] });
          return 200;
        }).catch((error) => {
          if (error instanceof AccountSessionBusy || (error as { code?: string }).code === "55P03")
            return 409;
          throw error;
        });
        return result === 200 ? true : json(res, result, { error: result === 403
          ? "Доступ владельца отозван" : result === 404 ? "Карточка не опубликована"
            : "Доступ занят. Повторите запрос" });
      }
      const rows = terms
        ? await db.prepare("", `${base} AND search_vector @@ to_tsquery('simple',?)
            ORDER BY name,person_id LIMIT 30`).all(archiveId,terms)
        : await db.prepare("", `${base} ORDER BY name,person_id LIMIT 30`).all(archiveId);
      return json(res, 200, { archiveId, people: rows.map(ownPerson) });
    }

    if (collection && req.method === "GET") {
      const after = cursor(url.searchParams.get("cursor"));
      if (!after) return json(res, 400, { error: "Некорректная страница" });
      const pageSql = `${projection}
        WHERE (m.left_archive_id=? OR m.right_archive_id=?)
          AND (m.requested_at,m.id) < (?::timestamptz,?)
        ORDER BY m.requested_at DESC,m.id DESC LIMIT 31`;
      const preliminary = await db.prepare("", pageSql).all(archiveId,archiveId,...after);
      const publicationKeys = [...new Map(preliminary.flatMap((row) =>
        (["left","right"] as const).flatMap((side) => row[`${side}_name`] == null ? [] : [{
          archive_id: String(row[`${side}_archive_id`]),
          person_id: String(row[`${side}_person_id`]),
        }])).map((key) => [`${key.archive_id}\0${key.person_id}`,key])).values()];
      const lockedKeys = new Set(publicationKeys.map((key) =>
        `${key.archive_id}\0${key.person_id}`));
      const result = await db.transaction(async () => {
        if (!await isOwner(user.id,true)) return 403;
        // Withdrawal locks publications before its trigger updates match
        // requests. Use that order, then keep both sets through delivery.
        if (publicationKeys.length) {
          const lockedPublications = await db.prepare("", `SELECT d.archive_id,d.person_id
            FROM discovery_people d JOIN jsonb_to_recordset(?::jsonb)
              AS e(archive_id text,person_id text)
              ON e.archive_id=d.archive_id AND e.person_id=d.person_id
            ORDER BY d.archive_id COLLATE "C",d.person_id COLLATE "C" FOR SHARE OF d`)
            .all(JSON.stringify(publicationKeys));
          if (lockedPublications.length !== publicationKeys.length) return 409;
        }
        if (preliminary.length) {
          const lockedMatches = await db.prepare("", `SELECT m.id
            FROM discovery_match_requests m JOIN jsonb_to_recordset(?::jsonb) AS e(id text)
              ON e.id=m.id ORDER BY m.id FOR SHARE OF m`)
            .all(JSON.stringify(preliminary.map((row) => ({ id: String(row.id) }))));
          if (lockedMatches.length !== preliminary.length) return 409;
        }
        const rows = await db.prepare("", pageSql).all(archiveId,archiveId,...after);
        if (rows.length !== preliminary.length || rows.some((row,index) =>
          row.id !== preliminary[index].id ||
          (["left","right"] as const).some((side) => row[`${side}_name`] != null &&
            !lockedKeys.has(`${row[`${side}_archive_id`]}\0${row[`${side}_person_id`]}`))))
          return 409;
        const items = rows.slice(0, 30).map(match);
        const last = rows.length > 30 ? items.at(-1) : undefined;
        await beforeMatchListDelivery?.();
        await deliverLocked(res, { archiveId, matches: items,
          nextCursor: last ? Buffer.from(JSON.stringify([last.requestedAt,last.id])).toString("base64url") : null });
        return 200;
      });
      return result === 200 ? true : json(res, result, { error: result === 403
        ? "Доступ владельца отозван" : "Сопоставления изменились. Обновите список." });
    }
    if (collection && req.method === "POST") {
      if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
        return json(res, 429, { error: "Слишком много запросов" });
      const body = await readBody(req);
      const sourceId = body?.sourcePersonId;
      const targetArchiveId = body?.targetArchiveId;
      const targetId = body?.targetPersonId;
      const reason = body?.reason ?? "";
      if (!publicPersonId(sourceId) ||
          typeof targetArchiveId !== "string" || !archivePattern.test(targetArchiveId) ||
          !publicPersonId(targetId) || targetArchiveId === archiveId)
        return json(res, 400, { error: "Выберите две опубликованные карточки из разных архивов" });
      if (typeof reason !== "string" || reason.trim().length > 500)
        return json(res, 400, { error: "Комментарий должен быть короче 500 символов" });
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true || !await isOwner(approved.id))
        return json(res, 403, { error: "Доступ отозван" });
      const pair = [[archiveId,sourceId],[targetArchiveId,targetId]].sort((a,b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
      const result = await db.transaction(async () => {
        if (!await isOwner(approved.id,true)) return undefined;
        const visible = await db.prepare("", `SELECT archive_id,person_id FROM discovery_people
          WHERE (archive_id=? AND person_id=?) OR (archive_id=? AND person_id=?)
          ORDER BY archive_id COLLATE "C",person_id COLLATE "C" FOR SHARE`)
          .all(archiveId,sourceId,targetArchiveId,targetId);
        if (visible.length !== 2) return null;
        const inserted = await db.prepare("", `INSERT INTO discovery_match_requests(
          id,left_archive_id,left_person_id,right_archive_id,right_person_id,
          initiated_by_archive_id,requested_by,reason)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(left_archive_id,left_person_id,right_archive_id,right_person_id)
          DO NOTHING`).run(randomUUID(),pair[0][0],pair[0][1],pair[1][0],pair[1][1],archiveId,approved.id,
          reason.trim() || null);
        const row = await db.prepare("", `${projection} WHERE m.left_archive_id=? AND m.left_person_id=?
          AND m.right_archive_id=? AND m.right_person_id=?`).get(pair[0][0],pair[0][1],pair[1][0],pair[1][1]);
        if (inserted.changes && row) {
          const token = reviewToken(row);
          if (!token) throw new Error("Published match lost its projection during request");
          await db.prepare("", `UPDATE discovery_match_requests SET request_review_token=?
            WHERE id=?`).run(token,String(row.id));
          return { ...row, request_review_token: token };
        }
        return row;
      });
      if (result === undefined)
        return json(res, 403, { error: "Доступ владельца отозван" });
      return result ? deliverMutationMatch(result)
        : json(res, 409, { error: "Одна из карточек больше не открыта для поиска" });
    }
    if (detail && req.method === "PATCH") {
      const body = await readBody(req);
      const decision = body?.decision;
      if (decision !== "accept" && decision !== "reject" && decision !== "revoke")
        return json(res, 400, { error: "Некорректное решение" });
      const approved = await auth.currentUser(req);
      if (approved?.role !== "admin" || approved.approved !== true || !await isOwner(approved.id))
        return json(res, 403, { error: "Доступ отозван" });
      const result = await db.transaction(async () => {
        if (!await isOwner(approved.id,true))
          return { code: 403, error: "Доступ владельца отозван" };
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
        const current = decision === "revoke" ? null : await readMatch(detail[1]);
        const decisionToken = current ? reviewToken(current) : null;
        if (decision === "accept") {
          if (!decisionToken || typeof body?.reviewToken !== "string" ||
              body.reviewToken !== decisionToken)
            return { code: 409, error: "Карточки изменились. Проверьте сведения ещё раз перед подтверждением" };
        }
        await db.prepare("", `UPDATE discovery_match_requests SET status=?,
          responded_by=CASE WHEN ?='revoke' THEN responded_by ELSE ? END,
          responded_at=CASE WHEN ?='revoke' THEN responded_at ELSE now() END,
          decision_review_token=CASE WHEN ?='revoke' THEN decision_review_token ELSE ? END,
          revoked_by=CASE WHEN ?='revoke' THEN ? ELSE revoked_by END,
          revoked_at=CASE WHEN ?='revoke' THEN now() ELSE revoked_at END
        WHERE id=?`).run(decision === "accept" ? "linked" : decision === "reject" ? "rejected" : "revoked",
          decision,approved.id,decision,decision,decisionToken,
          decision,approved.id,decision,detail[1]);
        if (decision === "reject") await hideRejectedCandidate(row,archiveId,approved.id);
        return { code: 200, row: await readMatch(detail[1]) };
      });
      return "row" in result ? deliverMutationMatch(result.row!)
        : json(res, result.code, { error: result.error });
    }
    return json(res, 405, { error: "Метод не поддерживается" });
  };
}
