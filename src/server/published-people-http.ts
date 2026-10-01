import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { publishedPeopleStore } from "./published-people.ts";
import { publicPerson, publishablePerson } from "./published-people.ts";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
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
      value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) ||
      new Set(value).size !== value.length) return null;
  return value as string[];
}

export function publishedPeopleHttp({
  archive,
  auth,
  store,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  store: ReturnType<typeof publishedPeopleStore>;
  publicOrigin?: string;
}) {
  const limiter = createSharedRequestLimiter(archive.db, "published-people", { windowMs: 60_000, limit: 60 });
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
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const batch = url.pathname === "/api/admin/published-people/batch";
    const batchPreview = url.pathname === "/api/admin/published-people/batch/preview";
    const admin = /^\/api\/admin\/published-people\/([^/]+)$/.exec(
      url.pathname,
    );
    const detail = /^\/api\/published-people\/([^/]+)$/.exec(url.pathname);
    const search = url.pathname === "/api/published-people/search";
    if (!admin && !batch && !batchPreview && !detail && !search) return false;

    const user = await auth.currentUser(req);
    if (!user)
      return json(res, 401, {
        error: "Войдите, чтобы искать опубликованных людей",
      });
    if ((admin || batch || batchPreview) && (user.role !== "admin" || user.approved !== true))
      return json(res, 403, { error: "Публикация доступна администратору" });
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
      const result = await archive.db.transaction(async () => {
        const freshUser = await auth.currentUser(req);
        if (freshUser?.role !== "admin" || freshUser.approved !== true || freshUser.id !== user.id)
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
        if (freshUser?.role !== "admin" || freshUser.approved !== true || freshUser.id !== user.id)
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
    const snapshot = await archive.read();
    if (search) {
      const query = (url.searchParams.get("q") || "").trim();
      if (req.method !== "GET")
        return json(res, 405, { error: "Метод не поддерживается" });
      if (query.length < 2 || query.length > 100)
        return json(res, 400, {
          error: "Введите от 2 до 100 символов для поиска",
        });
      const entries = await store.entries();
      const terms = query
        .toLocaleLowerCase("ru-RU")
        .split(/\s+/)
        .filter(Boolean);
      const results = snapshot.family.people
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
      return json(res, 200, { results });
    }
    const personId = admin?.[1] || detail?.[1] || "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(personId))
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
          if (freshUser?.role !== "admin" || freshUser.approved !== true || freshUser.id !== user.id)
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
    return json(res, 200, { person: publicPerson(person, fields) });
  };
}
