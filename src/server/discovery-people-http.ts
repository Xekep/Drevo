import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { createRequestLimiter, requestClientKey } from "./request-rate-limit.ts";

type Cursor = [name: string, archiveId: string, personId: string];
type DiscoveryRow = Record<string, unknown>;

function listedPerson(row: DiscoveryRow) {
  return {
    archiveId: String(row.archive_id),
    id: String(row.person_id),
    name: String(row.name),
    ...(row.birth_surname ? { birthSurname: String(row.birth_surname) } : {}),
    ...(row.birth_year ? { birthYear: String(row.birth_year) } : {}),
    ...(row.death_year ? { deathYear: String(row.death_year) } : {}),
    ...(row.birth_place ? { birthPlace: String(row.birth_place) } : {}),
    ...(row.death_place ? { deathPlace: String(row.death_place) } : {}),
    publicationVersion: String(row.publication_version),
  };
}

function searchTerms(query: string) {
  const words = query.toLocaleLowerCase("ru-RU").replaceAll("ё", "е")
    .match(/[\p{L}\p{N}]+/gu) || [];
  return words.length && words.length <= 8
    ? words.map((word) => `${word}:*`).join(" & ")
    : null;
}

function readCursor(value: string | null): Cursor | null {
  if (!value) return ["", "", ""];
  if (value.length > 600) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3 ||
        parsed.some((part) => typeof part !== "string" || part.length > 200))
      return null;
    return parsed as Cursor;
  } catch {
    return null;
  }
}

/** Searches only the opt-in projection; source people JSONB is never queried. */
export function discoveryPeopleHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
) {
  const limiter = createRequestLimiter({ windowMs: 60_000, limit: 60 });
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const linkedPeople = async (archiveId: string, personId: string) => {
    const columns = "other.archive_id,other.person_id,other.name,other.birth_surname,other.birth_year,other.death_year,other.birth_place,other.death_place,other.publication_version";
    const rows = await db.prepare("", `SELECT ${columns} FROM discovery_match_requests m
      JOIN discovery_people other ON other.archive_id=m.right_archive_id AND other.person_id=m.right_person_id
      WHERE m.status='linked' AND m.left_archive_id=? AND m.left_person_id=?
      UNION ALL
      SELECT ${columns} FROM discovery_match_requests m
      JOIN discovery_people other ON other.archive_id=m.left_archive_id AND other.person_id=m.left_person_id
      WHERE m.status='linked' AND m.right_archive_id=? AND m.right_person_id=?
      ORDER BY name,archive_id,person_id LIMIT 51`).all(archiveId,personId,archiveId,personId);
    return { cards: rows.slice(0,50).map(listedPerson), truncated: rows.length > 50 };
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const detail = /^\/api\/discovery\/people\/([A-Za-z0-9-]{3,64})\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
    if (url.pathname !== "/api/discovery/people" && !detail) return false;
    if (db.kind !== "postgres")
      return json(res, 501, { error: "Общий поиск доступен с PostgreSQL" });
    if (req.method !== "GET")
      return json(res, 405, { error: "Метод не поддерживается" });
    const accountId = await auth.accountId(req);
    if (!accountId)
      return json(res, 401, { error: "Войдите, чтобы искать опубликованных людей" });
    if (!limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress)))
      return json(res, 429, { error: "Слишком много поисковых запросов" });
    const state = await db.prepare("", "SELECT ready FROM discovery_index_state WHERE singleton=true").get();
    if (state?.ready !== true)
      return json(res, 503, { error: "Поисковый каталог подготавливается" });
    if (detail) {
      const row = await db.prepare("", `SELECT archive_id,person_id,name,birth_surname,birth_year,death_year,
             birth_place,death_place,publication_version FROM discovery_people
             WHERE archive_id=? AND person_id=?`).get(detail[1], detail[2]);
      if (!row) return json(res, 404, { error: "Человек не найден" });
      const linked = await linkedPeople(detail[1],detail[2]);
      return json(res, 200, { person: listedPerson(row), linkedCards: linked.cards,
        linkedCardsTruncated: linked.truncated });
    }
    const query = (url.searchParams.get("q") || "").trim();
    const terms = query.length >= 2 && query.length <= 100 ? searchTerms(query) : null;
    if (!terms)
      return json(res, 400, { error: "Введите от 2 до 100 символов для поиска" });
    const cursor = readCursor(url.searchParams.get("cursor"));
    if (!cursor) return json(res, 400, { error: "Некорректная страница поиска" });
    const rows = await db.prepare("", `SELECT archive_id,person_id,name,birth_surname,birth_year,death_year,
             birth_place,death_place,publication_version
        FROM discovery_people
       WHERE search_vector @@ to_tsquery('simple', ?)
         AND (name,archive_id,person_id) > (?,?,?)
       ORDER BY name,archive_id,person_id LIMIT 31`).all(
      terms, ...cursor,
    );
    const items = rows.slice(0, 30).map(listedPerson);
    const last = rows.length > 30 ? items.at(-1) : undefined;
    const nextCursor = last
      ? Buffer.from(JSON.stringify([last.name,last.archiveId,last.id])).toString("base64url")
      : null;
    return json(res, 200, { results: items, nextCursor });
  };
}
