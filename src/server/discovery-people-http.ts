import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { decodePublicPersonId } from "./public-person-id.ts";

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
  beforeDetailLookup?: () => Promise<void>,
  beforeSearchDelivery?: () => Promise<void>,
  beforeDetailDelivery?: () => Promise<void>,
) {
  const limiter = createSharedRequestLimiter(db, "discovery-people", { windowMs: 60_000, limit: 60 });
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
  const detailColumns = "archive_id,person_id,name,birth_surname,birth_year,death_year,birth_place,death_place,publication_version";
  const linkedColumns = detailColumns.split(",").map((column) => `other.${column}`).join(",");
  const linkedPeople = async (archiveId: string, personId: string,
    publicationVersion: string, rowVersion: string) => {
    // One final PostgreSQL snapshot covers the requested card and every linked
    // card. A second independent query would leave either side stale on revoke.
    const rows = await db.prepare("", `WITH chosen AS (
        SELECT ${detailColumns},xmin::text AS row_version FROM discovery_people
        WHERE archive_id=? AND person_id=?
      )
      SELECT chosen.*,to_jsonb(other) AS linked_card FROM chosen
      LEFT JOIN LATERAL (
        SELECT ${linkedColumns} FROM discovery_linked_pairs m
        JOIN discovery_people other ON other.archive_id=m.right_archive_id AND other.person_id=m.right_person_id
        WHERE m.left_archive_id=chosen.archive_id AND m.left_person_id=chosen.person_id
        UNION ALL
        SELECT ${linkedColumns} FROM discovery_linked_pairs m
        JOIN discovery_people other ON other.archive_id=m.left_archive_id AND other.person_id=m.left_person_id
        WHERE m.right_archive_id=chosen.archive_id AND m.right_person_id=chosen.person_id
        ORDER BY name,archive_id,person_id LIMIT 51
      ) other ON true
      WHERE chosen.publication_version=? AND chosen.row_version=?`).all(
      archiveId,personId,publicationVersion,rowVersion);
    const cards = rows.flatMap((row) => {
      if (!row.linked_card) return [];
      // The PostgreSQL store intentionally leaves jsonb as text for callers.
      const linked: unknown = typeof row.linked_card === "string"
        ? JSON.parse(row.linked_card) : row.linked_card;
      if (!linked || typeof linked !== "object" || Array.isArray(linked))
        throw new Error("Invalid linked discovery card projection");
      return [listedPerson(linked as DiscoveryRow)];
    });
    return rows.length ? { person: listedPerson(rows[0]), cards: cards.slice(0,50),
      selectedCards: cards,
      truncated: cards.length > 50 } : null;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const detail = /^\/api\/discovery\/people\/([A-Za-z0-9-]{3,64})\/([^/]{1,1200})$/.exec(url.pathname);
    if (url.pathname !== "/api/discovery/people" && !detail) return false;
    if (db.kind !== "postgres")
      return json(res, 501, { error: "Общий поиск доступен с PostgreSQL" });
    if (req.method !== "GET")
      return json(res, 405, { error: "Метод не поддерживается" });
    const accountId = await auth.accountId(req);
    if (!accountId)
      return json(res, 401, { error: "Войдите, чтобы искать опубликованных людей" });
    if (!(await limiter.allow(requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress))))
      return json(res, 429, { error: "Слишком много поисковых запросов" });
    const state = await db.prepare("", "SELECT ready FROM discovery_index_state WHERE singleton=true").get();
    if (state?.ready !== true)
      return json(res, 503, { error: "Поисковый каталог подготавливается" });
    if (detail) {
      const personId = decodePublicPersonId(detail[2]);
      if (!personId) return json(res, 404, { error: "Человек не найден" });
      const row = await db.prepare("", `SELECT ${detailColumns},xmin::text AS row_version FROM discovery_people
             WHERE archive_id=? AND person_id=?`).get(detail[1], personId);
      if (!row) return json(res, 404, { error: "Человек не найден" });
      await beforeDetailLookup?.();
      const result = await db.transaction(async () => {
        const linked = await linkedPeople(detail[1],personId,
          String(row.publication_version),String(row.row_version));
        if (!linked) return 404;
        const chosen = { archive_id: detail[1], person_id: personId };
        const expected = [chosen,...linked.selectedCards.map((card) => ({
          archive_id: card.archiveId, person_id: card.id,
        }))];
        // Unpublication locks the published rows before cascading into linked
        // pairs. Lock every delivered card (including the overflow card) first.
        const published = await db.prepare("", `SELECT d.archive_id,d.person_id
          FROM discovery_people d JOIN jsonb_to_recordset(?::jsonb)
            AS e(archive_id text,person_id text)
            ON e.archive_id=d.archive_id AND e.person_id=d.person_id
          ORDER BY d.archive_id COLLATE "C",d.person_id COLLATE "C" FOR SHARE OF d`)
          .all(JSON.stringify(expected));
        if (published.length !== expected.length) return 409;
        const pairs = linked.selectedCards.length ? await db.prepare("", `SELECT p.left_archive_id
          FROM discovery_linked_pairs p JOIN jsonb_to_recordset(?::jsonb)
            AS e(archive_id text,person_id text)
            ON (p.left_archive_id=? AND p.left_person_id=?
              AND p.right_archive_id=e.archive_id AND p.right_person_id=e.person_id)
            OR (p.right_archive_id=? AND p.right_person_id=?
              AND p.left_archive_id=e.archive_id AND p.left_person_id=e.person_id)
          ORDER BY p.left_archive_id COLLATE "C",p.left_person_id COLLATE "C",
            p.right_archive_id COLLATE "C",p.right_person_id COLLATE "C" FOR SHARE OF p`)
          .all(JSON.stringify(expected.slice(1)),detail[1],personId,detail[1],personId) : [];
        if (pairs.length !== linked.selectedCards.length) return 409;
        const current = await linkedPeople(detail[1],personId,
          String(row.publication_version),String(row.row_version));
        if (!current) return 404;
        if (current.selectedCards.length !== linked.selectedCards.length ||
            current.selectedCards.some((card,index) =>
              card.archiveId !== linked.selectedCards[index].archiveId ||
              card.id !== linked.selectedCards[index].id)) return 409;
        await beforeDetailDelivery?.();
        const delivered = finished(res, { cleanup: true });
        const timeout = setTimeout(() => res.destroy(), 5_000);
        timeout.unref();
        try {
          json(res, 200, { person: current.person, linkedCards: current.cards,
            linkedCardsTruncated: current.truncated });
          await delivered;
        } catch (error) {
          const disconnected = res.destroyed;
          res.destroy();
          await delivered.catch(() => {});
          if (!disconnected) throw error;
        } finally { clearTimeout(timeout); }
        return 200;
      });
      return result === 200 ? true : json(res, result, { error: result === 404
        ? "Человек не найден" : "Опубликованная карточка изменилась. Обновите её." });
    }
    const query = (url.searchParams.get("q") || "").trim();
    const terms = query.length >= 2 && query.length <= 100 ? searchTerms(query) : null;
    if (!terms)
      return json(res, 400, { error: "Введите от 2 до 100 символов для поиска" });
    const excludeArchiveId = url.searchParams.get("excludeArchiveId") || "";
    if (excludeArchiveId && !/^[A-Za-z0-9-]{3,64}$/.test(excludeArchiveId))
      return json(res, 400, { error: "Некорректный архив для исключения" });
    const cursor = readCursor(url.searchParams.get("cursor"));
    if (!cursor) return json(res, 400, { error: "Некорректная страница поиска" });
    if (!db.postgresTransaction)
      throw new Error("PostgreSQL discovery search requires transactions");
    return await db.postgresTransaction(async (client) => {
      // The selected page, including its overflow row, stays published until
      // this response is flushed. A concurrent withdrawal waits on these row
      // locks, so publication and delivery have one observable order.
      const { rows } = await client.query(`SELECT archive_id,person_id,name,birth_surname,birth_year,
             death_year,birth_place,death_place,publication_version
        FROM discovery_people
       WHERE search_vector @@ to_tsquery('simple', $1)
         AND archive_id<>$2
         AND (name,archive_id,person_id) > ($3,$4,$5)
       ORDER BY name,archive_id,person_id LIMIT 31 FOR SHARE`,
      [terms,excludeArchiveId,...cursor]);
      await beforeSearchDelivery?.();
      const items = rows.slice(0, 30).map(listedPerson);
      const last = rows.length > 30 ? items.at(-1) : undefined;
      const nextCursor = last
        ? Buffer.from(JSON.stringify([last.name,last.archiveId,last.id])).toString("base64url")
        : null;
      const delivered = finished(res, { cleanup: true });
      // Do not let a stalled client hold publication rows indefinitely.
      const timeout = setTimeout(() => res.destroy(), 5_000);
      timeout.unref();
      try {
        json(res, 200, { results: items, nextCursor });
        await delivered;
      } finally { clearTimeout(timeout); }
      return true;
    });
  };
}
