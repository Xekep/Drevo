import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { publishedPeopleStore } from "./published-people.ts";
import { publicPerson, publishablePerson } from "./published-people.ts";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";

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
    const admin = /^\/api\/admin\/published-people\/([^/]+)$/.exec(
      url.pathname,
    );
    const detail = /^\/api\/published-people\/([^/]+)$/.exec(url.pathname);
    const search = url.pathname === "/api/published-people/search";
    if (!admin && !batch && !detail && !search) return false;

    const user = await auth.currentUser(req);
    if (!user)
      return json(res, 401, {
        error: "Войдите, чтобы искать опубликованных людей",
      });
    if ((admin || batch) && (user.role !== "admin" || user.approved !== true))
      return json(res, 403, { error: "Публикация доступна администратору" });
    if (
      !admin && !batch &&
      !(await limiter.allow(
        requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress),
      ))
    )
      return json(res, 429, { error: "Слишком много поисковых запросов" });
    if (
      req.method !== "GET" &&
      ((!admin && !batch) || !isSameOriginRequest(req, publicOrigin))
    )
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (!admin && !batch && req.method !== "GET")
      return json(res, 405, { error: "Метод не поддерживается" });

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
      if (!ids || (req.method === "POST" && !fields))
        return json(res, 400, { error: "Некорректный список людей или выбор полей" });
      const freshUser = await auth.currentUser(req);
      if (freshUser?.role !== "admin" || freshUser.approved !== true)
        return json(res, 403, { error: "Доступ к публикации отозван" });
      const result = await archive.db.transaction(async () => {
        const current = await archive.read();
        const people = new Map(current.family.people.map((person) => [person.id, person]));
        const chosen = ids.map((id) => people.get(id));
        if (chosen.some((person) => !person || (req.method === "POST" && !publishablePerson(person))))
          return false;
        for (const person of chosen) {
          if (!person) continue;
          if (req.method === "DELETE") await store.unpublish(person.id);
          else if (fields) await store.publish(person.id, freshUser.id, {
            birthSurname: fields.birthSurname && Boolean(person.maidenName),
            birthYear: fields.birthYear && Boolean(person.birth?.match(/\b\d{4}\b/)),
            deathYear: fields.deathYear && Boolean(person.death?.match(/\b\d{4}\b/)),
            birthPlace: fields.birthPlace && Boolean(person.birthPlace),
            deathPlace: fields.deathPlace && Boolean(person.deathPlace),
          });
        }
        return true;
      });
      return result ? json(res, 200, { count: ids.length })
        : json(res, 409, { error: "Список изменился; обновите его и повторите действие" });
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
      if (req.method === "PUT" || req.method === "DELETE") {
        if (!isSameOriginRequest(req, publicOrigin))
          return json(res, 403, { error: "Недопустимый источник запроса" });
        if (req.method === "PUT") {
          if (!publishablePerson(person))
            return json(res, 400, {
              error: "Публикация доступна только для умерших людей",
            });
          const fields = await requestedFields(req);
          if (!fields) return json(res, 400, { error: "Некорректный выбор полей публикации" });
          await store.publish(personId, user.id, {
            birthSurname: fields.birthSurname && Boolean(person.maidenName),
            birthYear: fields.birthYear && Boolean(person.birth?.match(/\b\d{4}\b/)),
            deathYear: fields.deathYear && Boolean(person.death?.match(/\b\d{4}\b/)),
            birthPlace: fields.birthPlace && Boolean(person.birthPlace),
            deathPlace: fields.deathPlace && Boolean(person.deathPlace),
          });
        } else await store.unpublish(personId);
      } else if (req.method !== "GET") {
        return json(res, 405, { error: "Метод не поддерживается" });
      }
      const fields = await store.getFields(personId);
      return json(res, 200, {
        archiveId: archive.db.kind === "postgres" ? archive.db.archiveId : null,
        published: Boolean(fields),
        publishable: publishablePerson(person),
        fields: fields || defaultPublicationFields,
        person: publicPerson(person, fields || defaultPublicationFields),
      });
    }
    const fields = await store.getFields(personId);
    if (!publishablePerson(person) || !fields)
      return json(res, 404, { error: "Человек не найден" });
    return json(res, 200, { person: publicPerson(person, fields) });
  };
}
