import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { publishedPeopleStore } from "./published-people.ts";
import { publicPerson, publishablePerson } from "./published-people.ts";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { decodePublicPersonId, publicPersonId } from "./public-person-id.ts";
import { AccountSessionBusy, AccountSessionExpired, assertActiveAccountSession } from "./account-session-guard.ts";
import type { Person } from "../domain/types.ts";

function visibleFields(person: Person, fields: PublicationFields): PublicationFields {
  return {
    birthSurname: fields.birthSurname && Boolean(person.maidenName),
    birthYear: fields.birthYear && Boolean(person.birth?.match(/\b\d{4}\b/)),
    deathYear: fields.deathYear && Boolean(person.death?.match(/\b\d{4}\b/)),
    birthPlace: fields.birthPlace && Boolean(person.birthPlace),
    deathPlace: fields.deathPlace && Boolean(person.deathPlace),
  };
}

async function readObject(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return undefined;
  if (!req.headers["content-type"]?.startsWith("application/json")) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function parseFields(value: unknown): PublicationFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const names = ["birthSurname", "birthYear", "deathYear", "birthPlace", "deathPlace"] as const;
  if (names.some((name) => typeof (value as Record<string, unknown>)[name] !== "boolean")) return null;
  return value as PublicationFields;
}

async function requestedFields(req: IncomingMessage): Promise<PublicationFields | null> {
  const body = await readObject(req, 2048);
  return body === undefined ? defaultPublicationFields : parseFields(body?.fields);
}

function batchIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 ||
      value.some((id) => !publicPersonId(id)) ||
      new Set(value).size !== value.length) return null;
  return value as string[];
}

export function publishedPeopleHttp({
  archive,
  auth,
  store,
  publicOrigin,
  beforePublicDelivery,
  beforeSearchDelivery,
  beforeAdminFinalLock,
  beforeAdminBatchFinalLock,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  store: ReturnType<typeof publishedPeopleStore>;
  publicOrigin?: string;
  beforePublicDelivery?: () => Promise<void>;
  beforeSearchDelivery?: () => Promise<void>;
  beforeAdminFinalLock?: () => Promise<void>;
  beforeAdminBatchFinalLock?: () => Promise<void>;
}) {
  const limiter = createSharedRequestLimiter(archive.db, "published-people", { windowMs: 60_000, limit: 60 });
  const isOwner = async (userId: string, lock = false) => {
    const db = archive.db;
    if (db.kind !== "postgres") return true;
    if (!db.archiveId) return false;
    return !!await db.prepare("", `SELECT 1 FROM archive_owners
      WHERE archive_id=? AND user_id=? ${lock ? "FOR SHARE" : ""}`).get(db.archiveId, userId);
  };
  async function reviewSelection(action: "publish" | "unpublish", ids: string[],
    fields: PublicationFields | null, userId: string) {
    const snapshot = await archive.read();
    const peopleById = new Map(snapshot.family.people.map((person) => [person.id, person]));
    const selected = ids.map((id) => peopleById.get(id));
    if (selected.some((person) => !person || (action === "publish" && !publishablePerson(person))))
      return null;
    const current = await store.fieldsForIds(ids);
    const people = selected.map((person) => {
      const safe = person!;
      const previous = current.get(safe.id);
      return {
        id: safe.id,
        published: Boolean(previous),
        fields: action === "publish" ? visibleFields(safe, fields!) : previous || null,
        person: action === "publish"
          ? publicPerson(safe, visibleFields(safe, fields!))
          : previous ? publicPerson(safe, previous) : publicPerson(safe, {
            birthSurname: false, birthYear: false, deathYear: false,
            birthPlace: false, deathPlace: false,
          }),
      };
    });
    const revision = snapshot.revision;
    const reviewToken = createHash("sha256").update(JSON.stringify({
      archive: archive.db.archiveId || archive.db.file, userId, action, ids, fields,
      revision, people, current: ids.map((id) => current.get(id) || null),
    })).digest("hex");
    return { revision, reviewToken, people };
  }
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
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
  const deliverOwnerBatch = async (req: IncomingMessage, res: ServerResponse,
    initialUserId: string, value: (userId: string) => Promise<unknown | null>) => {
    await beforeAdminBatchFinalLock?.();
    const status = await archive.db.transaction(async () => {
      const freshUser = await auth.currentUser(req);
      if (!freshUser) return 401;
      if (freshUser.id !== initialUserId) return 403;
      if (!auth.local) {
        const session = await auth.accountSession(req);
        if (!session || session.accountId !== freshUser.id) return 401;
        await assertActiveAccountSession(archive.db, freshUser.id, session.tokenHash);
      }
      // The transaction locks the archive before these rows, matching owner
      // transfer and membership writes. Hold all locks through delivery.
      if (!await isOwner(freshUser.id, true)) return 403;
      const archiveId = archive.db.archiveId;
      if (!archiveId) return 403;
      const membership = await archive.db.prepare("", `SELECT role,approved
        FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE`)
        .get(archiveId, freshUser.id);
      if (membership?.role !== "admin" || membership.approved !== true) return 403;
      const payload = await value(freshUser.id);
      if (payload === null) return 409;
      await deliverLocked(res, payload);
      return 200;
    }).catch((error) => {
      if (error instanceof AccountSessionExpired) return 401;
      if (error instanceof AccountSessionBusy ||
          (error as { code?: string }).code === "55P03") return 409;
      throw error;
    });
    return status === 200 ? true : json(res, status, { error: status === 401
      ? "Сессия завершена. Войдите снова" : status === 403
        ? "Доступ к публикации отозван" : "Данные заняты или изменились. Повторите запрос" });
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const batch = url.pathname === "/api/admin/published-people/batch";
    const batchPreview = url.pathname === "/api/admin/published-people/batch/preview";
    const admin = /^\/api\/admin\/published-people\/([^/]{1,1200})$/.exec(
      url.pathname,
    );
    const detail = /^\/api\/published-people\/([^/]{1,1200})$/.exec(url.pathname);
    const search = url.pathname === "/api/published-people/search";
    if (!admin && !batch && !batchPreview && !detail && !search) return false;

    const user = await auth.currentUser(req);
    if (!user)
      return json(res, 401, {
        error: "Войдите, чтобы искать опубликованных людей",
      });
    if ((admin || batch || batchPreview) &&
        (user.role !== "admin" || user.approved !== true || !await isOwner(user.id)))
      return json(res, 403, { error: "Публикация доступна владельцу дерева" });
    if (
      !admin && !batch && !batchPreview &&
      !(await limiter.allow(
        requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress),
      ))
    )
      return json(res, 429, { error: "Слишком много поисковых запросов" });
    if (
      req.method !== "GET" &&
      ((!admin && !batch && !batchPreview) || !isSameOriginRequest(req, publicOrigin))
    )
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (!admin && !batch && !batchPreview && req.method !== "GET")
      return json(res, 405, { error: "Метод не поддерживается" });

    if (batchPreview) {
      if (req.method !== "POST")
        return json(res, 405, { error: "Метод не поддерживается" });
      const body = await readObject(req, 8192);
      const ids = batchIds(body?.personIds);
      const action = body?.action;
      const fields = action === "publish" ? parseFields(body?.fields) : null;
      if (!ids || (action !== "publish" && action !== "unpublish") ||
          (action === "publish" && !fields))
        return json(res, 400, { error: "Некорректный список людей или выбор полей" });
      if (archive.db.kind === "postgres")
        return deliverOwnerBatch(req, res, user.id, async (userId) =>
          await reviewSelection(action, ids, fields, userId));
      const result = await archive.db.transaction(async () => {
        const freshUser = await auth.currentUser(req);
        if (freshUser?.role !== "admin" || freshUser.approved !== true ||
            freshUser.id !== user.id || !await isOwner(freshUser.id))
          return { status: "forbidden" as const };
        const review = await reviewSelection(action, ids, fields, freshUser.id);
        return review ? { status: "ok" as const, review } : { status: "conflict" as const };
      }, true);
      return result.status === "ok" ? json(res, 200, result.review)
        : result.status === "forbidden" ? json(res, 403, { error: "Доступ к публикации отозван" })
          : json(res, 409, { error: "Список изменился; обновите его и повторите действие" });
    }
    if (batch) {
      if (req.method === "GET") {
        const ids = batchIds(url.searchParams.getAll("id"));
        if (!ids) return json(res, 400, { error: "Укажите от 1 до 50 людей" });
        if (archive.db.kind === "postgres")
          return deliverOwnerBatch(req, res, user.id, async () =>
            ({ fields: Object.fromEntries(await store.fieldsForIds(ids)) }));
        return json(res, 200, { fields: Object.fromEntries(await store.fieldsForIds(ids)) });
      }
      if (req.method !== "POST" && req.method !== "DELETE")
        return json(res, 405, { error: "Метод не поддерживается" });
      const body = await readObject(req, 8192);
      const ids = batchIds(body?.personIds);
      const fields = req.method === "POST" ? parseFields(body?.fields) : null;
      const revision = body?.revision;
      const reviewToken = body?.reviewToken;
      if (!ids || (req.method === "POST" && !fields))
        return json(res, 400, { error: "Некорректный список людей или выбор полей" });
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
          typeof reviewToken !== "string" || !/^[0-9a-f]{64}$/.test(reviewToken))
        return json(res, 400, { error: "Сначала проверьте список публикации" });
      const result = await archive.db.transaction(async () => {
        const freshUser = await auth.currentUser(req);
        if (freshUser?.role !== "admin" || freshUser.approved !== true ||
            freshUser.id !== user.id || !await isOwner(freshUser.id, true))
          return "forbidden";
        const action = req.method === "POST" ? "publish" : "unpublish";
        const review = await reviewSelection(action, ids, fields, freshUser.id);
        if (!review || review.revision !== revision || review.reviewToken !== reviewToken)
          return "conflict";
        for (const item of review.people) {
          if (action === "unpublish") await store.unpublish(item.id);
          else await store.publish(item.id, freshUser.id, item.fields!);
        }
        return "ok";
      });
      return result === "ok" ? json(res, 200, { count: ids.length })
        : result === "forbidden" ? json(res, 403, { error: "Доступ к публикации отозван" })
          : json(res, 409, { error: "Список или архив изменился; проверьте публикацию заново" });
    }
    if (admin && req.method === "GET" && archive.db.kind === "postgres") {
      const personId = decodePublicPersonId(admin[1]);
      if (!personId) return json(res, 404, { error: "Человек не найден" });
      await beforeAdminFinalLock?.();
      const status = await archive.db.transaction(async () => {
        const freshUser = await auth.currentUser(req);
        if (!freshUser) return 401;
        if (freshUser.id !== user.id) return 403;
        if (!auth.local) {
          const session = await auth.accountSession(req);
          if (!session || session.accountId !== freshUser.id) return 401;
          await assertActiveAccountSession(archive.db, freshUser.id, session.tokenHash);
        }
        // Transfer and membership writes lock the archive first. Keep that
        // order, then hold these rows until the response finishes.
        if (!await isOwner(freshUser.id, true)) return 403;
        const archiveId = archive.db.archiveId;
        if (!archiveId) return 403;
        const membership = await archive.db.prepare("", `SELECT role,approved
          FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE`)
          .get(archiveId, freshUser.id);
        if (membership?.role !== "admin" || membership.approved !== true) return 403;
        const freshPerson = (await archive.read()).family.people.find((entry) => entry.id === personId);
        if (!freshPerson) return 404;
        const fields = await store.getFields(personId);
        await deliverLocked(res, {
          archiveId,
          published: Boolean(fields),
          publishable: publishablePerson(freshPerson),
          fields: fields || defaultPublicationFields,
          person: publicPerson(freshPerson, fields || defaultPublicationFields),
        });
        return 200;
      }).catch((error) => {
        if (error instanceof AccountSessionExpired) return 401;
        if (error instanceof AccountSessionBusy ||
            (error as { code?: string }).code === "55P03") return 409;
        throw error;
      });
      return status === 200 ? true : json(res, status, { error: status === 401
        ? "Сессия завершена. Войдите снова" : status === 403
          ? "Доступ к публикации отозван" : status === 404
            ? "Человек не найден" : "Данные заняты другим действием. Повторите запрос" });
    }
    const snapshot = await archive.read();
    if (search) {
      const query = (url.searchParams.get("q") || "").trim();
      if (req.method !== "GET")
        return json(res, 405, { error: "Метод не поддерживается" });
      if (query.length < 2 || query.length > 100)
        return json(res, 400, {
          error: "Введите от 2 до 100 символов для поиска",
        });
      const terms = query
        .toLocaleLowerCase("ru-RU")
        .split(/\s+/)
        .filter(Boolean);
      const matching = (family: typeof snapshot.family,
        entries: Awaited<ReturnType<typeof store.entries>>) => family.people
        .filter((person) => entries.has(person.id) && publishablePerson(person))
        .map((person) => publicPerson(person, entries.get(person.id)))
        .filter((person) => {
          const searchable = [
            person.name,
            person.birthSurname,
            person.birthYear,
            person.deathYear,
            person.birthPlace,
            person.deathPlace,
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase("ru-RU");
          return terms.every((term) => searchable.includes(term));
        })
        .slice(0, 30);
      const results = matching(snapshot.family, await store.entries());
      if (archive.db.kind !== "postgres") {
        await beforeSearchDelivery?.();
        return json(res, 200, { results });
      }
      return archive.db.transaction(async () => {
        // archive.read locks the archive row. Writers take that row before
        // changing published_people, so acquire it before publication locks.
        const currentSnapshot = await archive.read();
        if (results.length) {
          const locked = await archive.db.prepare("", `SELECT person_id FROM published_people
            WHERE person_id IN (${results.map(() => "?").join(",")})
            ORDER BY person_id COLLATE "C" FOR SHARE`)
            .all(...results.map((person) => person.id));
          if (locked.length !== results.length)
            return json(res, 409, { error: "Публикации изменились. Обновите поиск." });
        }
        const current = matching(currentSnapshot.family, await store.entries());
        if (current.length !== results.length || current.some((person,index) =>
          person.id !== results[index].id))
          return json(res, 409, { error: "Публикации изменились. Обновите поиск." });
        await beforeSearchDelivery?.();
        await deliverLocked(res, { results: current });
        return true;
      });
    }
    const personId = decodePublicPersonId(admin?.[1] || detail?.[1] || "");
    if (!personId)
      return json(res, 404, { error: "Человек не найден" });
    const person = snapshot.family.people.find(
      (entry) => entry.id === personId,
    );
    if (!person) return json(res, 404, { error: "Человек не найден" });

    if (admin) {
      let currentPerson = person;
      if (req.method === "PUT" || req.method === "DELETE") {
        if (!isSameOriginRequest(req, publicOrigin))
          return json(res, 403, { error: "Недопустимый источник запроса" });
        const fields = req.method === "PUT" ? await requestedFields(req) : null;
        if (req.method === "PUT" && !fields)
          return json(res, 400, { error: "Некорректный выбор полей публикации" });
        const result = await archive.db.transaction(async () => {
          const freshUser = await auth.currentUser(req);
          if (freshUser?.role !== "admin" || freshUser.approved !== true ||
              freshUser.id !== user.id || !await isOwner(freshUser.id, true))
            return { status: "forbidden" as const };
          const freshPerson = (await archive.read()).family.people.find((entry) => entry.id === personId);
          if (!freshPerson) return { status: "missing" as const };
          if (req.method === "PUT") {
            if (!publishablePerson(freshPerson)) return { status: "living" as const };
            await store.publish(personId, freshUser.id, visibleFields(freshPerson, fields!));
          } else await store.unpublish(personId);
          return { status: "ok" as const, person: freshPerson };
        });
        if (result.status === "forbidden") return json(res, 403, { error: "Доступ к публикации отозван" });
        if (result.status === "missing") return json(res, 404, { error: "Человек не найден" });
        if (result.status === "living") return json(res, 400, { error: "Публикация доступна только для умерших людей" });
        currentPerson = result.person;
      } else if (req.method !== "GET") {
        return json(res, 405, { error: "Метод не поддерживается" });
      }
      const fields = await store.getFields(personId);
      return json(res, 200, {
        archiveId: archive.db.kind === "postgres" ? archive.db.archiveId : null,
        published: Boolean(fields),
        publishable: publishablePerson(currentPerson),
        fields: fields || defaultPublicationFields,
        person: publicPerson(currentPerson, fields || defaultPublicationFields),
      });
    }
    const fields = await store.getFields(personId);
    if (!publishablePerson(person) || !fields)
      return json(res, 404, { error: "Человек не найден" });
    if (archive.db.kind !== "postgres") {
      await beforePublicDelivery?.();
      return json(res, 200, { person: publicPerson(person, fields) });
    }
    return archive.db.transaction(async () => {
      const currentSnapshot = await archive.read();
      const published = await archive.db.prepare("", `SELECT person_id FROM published_people
        WHERE person_id=? FOR SHARE`).get(personId);
      if (!published) return json(res, 404, { error: "Человек не найден" });
      const currentPerson = currentSnapshot.family.people.find((entry) => entry.id === personId);
      const currentFields = await store.getFields(personId);
      if (!currentPerson || !publishablePerson(currentPerson) || !currentFields)
        return json(res, 404, { error: "Человек не найден" });
      await beforePublicDelivery?.();
      await deliverLocked(res, { person: publicPerson(currentPerson, currentFields) });
      return true;
    });
  };
}
