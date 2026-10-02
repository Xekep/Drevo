import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { candidateEvidence, candidateFuzzyTerms, candidateNameQuery, candidatePlaceQueries,
  candidateRelativeQuery, type PublishedRelative } from "./discovery-candidate-ranking.ts";
import { publicPersonId } from "./public-person-id.ts";

const archivePattern = /^[A-Za-z0-9-]{3,64}$/;
const matchPattern = /^[a-f0-9-]{36}$/;
const candidatePageSize = 24;
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

function published(row: Row) {
  return {
    archiveId: String(row.archive_id), id: String(row.person_id), name: String(row.name),
    ...(row.birth_surname ? { birthSurname: String(row.birth_surname) } : {}),
    ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
    ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
    ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
    ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
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

function candidateCursor(value: string | null): [string,string,string] | null {
  if (!value) return ["", "", ""];
  if (value.length > 1500) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(parsed) && parsed.length === 3 &&
      parsed.every((part) => typeof part === "string" && part.length <= 512)
      ? parsed as [string,string,string] : null;
  } catch { return null; }
}

export function discoveryMatchesHttp({ archive, auth, publicOrigin,
  beforeCandidateRelatives, beforeCandidateDelivery }: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  beforeCandidateRelatives?: () => Promise<void>;
  beforeCandidateDelivery?: () => Promise<void>;
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
    const ignoredCandidates = url.pathname === "/api/discovery/matches/ignored";
    const ignoredArchives = url.pathname === "/api/discovery/matches/ignored-archives";
    const detail = /^\/api\/discovery\/matches\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (!collection && !ownPeople && !candidates && !ignoredCandidates && !ignoredArchives && !detail) return false;
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

    if (ignoredArchives) {
      if (req.method === "GET") {
        const page = Number(url.searchParams.get("page") || "0");
        if (!Number.isInteger(page) || page < 0 || page > 1000)
          return json(res, 400, { error: "Некорректная страница" });
        const rows = await db.prepare("", `SELECT i.target_archive_id,
          (SELECT d.name FROM discovery_people d WHERE d.archive_id=i.target_archive_id
            ORDER BY d.name,d.person_id LIMIT 1) AS example_name
          FROM discovery_ignored_archives i WHERE i.archive_id=?
          ORDER BY i.ignored_at DESC,i.target_archive_id LIMIT 31 OFFSET ?`).all(archiveId,page*30);
        return json(res, 200, { archives: rows.slice(0,30).map((row) => ({
          archiveId: String(row.target_archive_id),
          ...(row.example_name ? { exampleName: String(row.example_name) } : {}),
        })), nextPage: rows.length > 30 ? page + 1 : null });
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
      const after = candidateCursor(url.searchParams.get("cursor"));
      if (!after) return json(res, 400, { error: "Некорректная страница подсказок" });
      const columns = `archive_id,person_id,name,birth_surname,birth_year,death_year,birth_place,death_place,
        publication_version::text AS publication_version,xmin::text AS row_version`;
      const sourceRow = await db.prepare("", `SELECT ${columns} FROM discovery_people
        WHERE archive_id=? AND person_id=?`).get(archiveId,sourceId);
      if (!sourceRow) return json(res, 404, { error: "Карточка больше не опубликована" });
      const source = published(sourceRow);
      const terms = candidateNameQuery(source);
      const sourceRelativeRows = await db.prepare("", `SELECT relative_person_id,kind,relative_name
        FROM discovery_relative_names
        WHERE archive_id=? AND person_id=?
        ORDER BY CASE kind WHEN 'parent' THEN 0 WHEN 'spouse' THEN 1 ELSE 2 END,
          relative_name LIMIT 24`)
        .all(archiveId,sourceId);
      const sourceRelatives = sourceRelativeRows.map((row) => ({
          kind: String(row.kind) as PublishedRelative["kind"], name: String(row.relative_name),
        }));
      const fuzzy = candidateFuzzyTerms(source);
      const places = candidatePlaceQueries(source);
      const relativeTerms = candidateRelativeQuery(sourceRelatives);
      if (!terms && !fuzzy && !places.length && !relativeTerms)
        return json(res, 200, { candidates: [], truncated: false, nextCursor: null });
      const showIgnored = url.searchParams.get("ignored") === "1";
      const branches: string[] = [], lookupArgs: string[] = [];
      if (terms) {
        branches.push(`SELECT archive_id,person_id FROM discovery_people
          WHERE archive_id<>? AND name_vector @@ to_tsquery('simple',?)`);
        lookupArgs.push(archiveId,terms);
      }
      if (fuzzy) {
        const surnames = fuzzy.surnames.map(() =>
          `(surname_normalized % ? OR birth_surname_normalized % ?)`).join(" OR ");
        branches.push(`SELECT archive_id,person_id FROM discovery_people
          WHERE archive_id<>? AND given_normalized % ? AND (${surnames})`);
        lookupArgs.push(archiveId,fuzzy.given,
          ...fuzzy.surnames.flatMap((value) => [value,value]));
      }
      for (const place of places) {
        branches.push(`SELECT archive_id,person_id FROM discovery_people
          WHERE archive_id<>? AND search_vector @@ to_tsquery('simple',?)
            AND birth_year BETWEEN ? AND ?`);
        lookupArgs.push(archiveId,place.terms,place.from,place.to);
      }
      if (relativeTerms) {
        branches.push(`SELECT archive_id,person_id FROM discovery_relative_names
          WHERE archive_id<>? AND name_vector @@ to_tsquery('simple',?)`);
        lookupArgs.push(archiveId,relativeTerms);
      }
      // Each branch starts with a GIN index. Only opt-in projections are read.
      const candidateSql = `WITH candidate_keys AS (${branches.join(" UNION ")})
        SELECT d.archive_id,d.person_id,d.name,d.birth_surname,
          d.birth_year,d.death_year,d.birth_place,d.death_place,
          d.publication_version::text AS publication_version,d.xmin::text AS row_version
          FROM discovery_people d
        JOIN candidate_keys k ON k.archive_id=d.archive_id AND k.person_id=d.person_id
        WHERE d.archive_id<>?
          AND (d.name,d.archive_id,d.person_id) > (?,?,?)
          AND NOT EXISTS (SELECT 1 FROM discovery_ignored_archives a
            WHERE a.archive_id=? AND a.target_archive_id=d.archive_id)
          AND ${showIgnored ? "EXISTS" : "NOT EXISTS"} (
            SELECT 1 FROM discovery_ignored_candidates i WHERE i.archive_id=?
              AND i.source_person_id=? AND i.target_archive_id=d.archive_id
              AND i.target_person_id=d.person_id)
          AND NOT EXISTS (
            SELECT 1 FROM discovery_match_requests m WHERE m.status='linked' AND (
              (m.left_archive_id=? AND m.left_person_id=?
                AND m.right_archive_id=d.archive_id AND m.right_person_id=d.person_id)
              OR (m.right_archive_id=? AND m.right_person_id=?
                AND m.left_archive_id=d.archive_id AND m.left_person_id=d.person_id)))
        ORDER BY d.name,d.archive_id,d.person_id LIMIT ${candidatePageSize + 1}`;
      const candidateArgs = [...lookupArgs,archiveId,...after,archiveId,archiveId,sourceId,
        archiveId,sourceId,archiveId,sourceId];
      const rows = await db.prepare("", candidateSql).all(...candidateArgs);
      await beforeCandidateRelatives?.();
      const page = rows.slice(0, candidatePageSize);
      const relativesByPerson = new Map<string, PublishedRelative[]>();
      let relativeRows: Row[] = [];
      if (page.length) {
        const values = page.map(() => "(?,?)").join(",");
        relativeRows = await db.prepare("", `SELECT p.archive_id,p.person_id,
          r.relative_person_id,r.kind,r.relative_name
          FROM (VALUES ${values}) AS p(archive_id,person_id)
          JOIN LATERAL (SELECT relative_person_id,kind,relative_name FROM discovery_relative_names
            WHERE archive_id=p.archive_id AND person_id=p.person_id
            ORDER BY CASE kind WHEN 'parent' THEN 0 WHEN 'spouse' THEN 1 ELSE 2 END,
              relative_name LIMIT 24) r ON true`)
          .all(...page.flatMap((row) => [String(row.archive_id),String(row.person_id)]));
        for (const row of relativeRows) {
          const key = `${row.archive_id}\u0000${row.person_id}`;
          const list = relativesByPerson.get(key) || [];
          list.push({ kind: String(row.kind) as PublishedRelative["kind"],
            name: String(row.relative_name) });
          relativesByPerson.set(key,list);
        }
      }
      const nextCursor = rows.length > candidatePageSize
        ? Buffer.from(JSON.stringify([
          page.at(-1)!.name, page.at(-1)!.archive_id, page.at(-1)!.person_id,
        ])).toString("base64url") : null;
      const ranked = page.map((row) => {
        const candidate = published(row);
        const evidence = candidateEvidence(source,candidate,sourceRelatives,
          relativesByPerson.get(`${row.archive_id}\u0000${row.person_id}`) || []);
        return evidence ? { ...candidate, ...evidence } : null;
      }).filter((item) => item !== null)
        .sort((a,b) => b.score - a.score || a.name.localeCompare(b.name,"ru-RU"))
        .map((item) => ({
          archiveId: item.archiveId, id: item.id, name: item.name,
          ...(item.birthSurname ? { birthSurname: item.birthSurname } : {}),
          ...(item.birthYear ? { birthYear: item.birthYear } : {}),
          ...(item.deathYear ? { deathYear: item.deathYear } : {}),
          ...(item.birthPlace ? { birthPlace: item.birthPlace } : {}),
          ...(item.deathPlace ? { deathPlace: item.deathPlace } : {}),
          reasons: item.reasons, conflicts: item.conflicts,
        }));
      await beforeCandidateDelivery?.();
      const expectedPeople = [sourceRow,...rows].map((row) => ({
        archive_id: String(row.archive_id), person_id: String(row.person_id),
        publication_version: String(row.publication_version), row_version: String(row.row_version),
      }));
      const expectedFocals = [sourceRow,...page].map((row) => ({
        archive_id: String(row.archive_id), person_id: String(row.person_id),
      }));
      const expectedRelatives = [
        ...sourceRelativeRows.map((row) => ({ ...expectedFocals[0],
          relative_person_id: String(row.relative_person_id), kind: String(row.kind),
          relative_name: String(row.relative_name) })),
        ...relativeRows.map((row) => ({
          archive_id: String(row.archive_id), person_id: String(row.person_id),
          relative_person_id: String(row.relative_person_id), kind: String(row.kind),
          relative_name: String(row.relative_name),
        })),
      ];
      const expectedPage = rows.map((row) => ({ archive_id: String(row.archive_id),
        person_id: String(row.person_id) }));
      // One MVCC snapshot checks the indexed page (including its overflow row),
      // selected publications and the complete top-24 relatives used for ranking.
      const current = await db.prepare("", `WITH expected_people AS (
          SELECT * FROM jsonb_to_recordset(?::jsonb) AS e(
            archive_id text,person_id text,publication_version text,row_version text)
        ), expected_focals AS (
          SELECT * FROM jsonb_to_recordset(?::jsonb) AS e(archive_id text,person_id text)
        ), expected_relatives AS (
          SELECT * FROM jsonb_to_recordset(?::jsonb) AS e(
            archive_id text,person_id text,relative_person_id text,kind text,relative_name text)
        ), expected_page AS (
          SELECT * FROM jsonb_to_recordset(?::jsonb) AS e(archive_id text,person_id text)
        ), current_page AS (${candidateSql}
        ), current_relatives AS (
          SELECT f.archive_id,f.person_id,r.relative_person_id,r.kind,r.relative_name
          FROM expected_focals f
          JOIN LATERAL (SELECT relative_person_id,kind,relative_name
            FROM discovery_relative_names
            WHERE archive_id=f.archive_id AND person_id=f.person_id
            ORDER BY CASE kind WHEN 'parent' THEN 0 WHEN 'spouse' THEN 1 ELSE 2 END,
              relative_name LIMIT 24) r ON true
        ) SELECT
          (SELECT count(*) FROM expected_people e JOIN discovery_people d
            ON d.archive_id=e.archive_id AND d.person_id=e.person_id
            AND d.publication_version::text=e.publication_version
            AND d.xmin::text=e.row_version) AS people_count,
          (SELECT count(*) FROM current_page c JOIN expected_page e
            ON c.archive_id=e.archive_id AND c.person_id=e.person_id) AS page_count,
          (SELECT count(*) FROM current_page) AS current_page_count,
          NOT EXISTS (SELECT * FROM expected_relatives EXCEPT SELECT * FROM current_relatives)
            AND NOT EXISTS (SELECT * FROM current_relatives EXCEPT SELECT * FROM expected_relatives)
            AS relatives_current`)
        .get(JSON.stringify(expectedPeople),JSON.stringify(expectedFocals),
          JSON.stringify(expectedRelatives),JSON.stringify(expectedPage),...candidateArgs);
      if (Number(current?.people_count) !== expectedPeople.length ||
          Number(current?.page_count) !== expectedPage.length ||
          Number(current?.current_page_count) !== expectedPage.length ||
          current?.relatives_current !== true)
        return json(res, 409, { error: "Опубликованные карточки изменились. Обновите подсказки." });
      return json(res, 200, { candidates: ranked, truncated: nextCursor !== null, nextCursor });
    }

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
      return result ? json(res, 200, { match: match(result) })
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
      return "row" in result ? json(res, 200, { match: match(result.row!) })
        : json(res, result.code, { error: result.error });
    }
    return json(res, 405, { error: "Метод не поддерживается" });
  };
}
