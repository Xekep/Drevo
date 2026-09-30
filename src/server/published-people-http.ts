import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { publishedPeopleStore } from "./published-people.ts";
import { publicPerson, publishablePerson } from "./published-people.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  createRequestLimiter,
  requestClientKey,
} from "./request-rate-limit.ts";

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
  const limiter = createRequestLimiter({ windowMs: 60_000, limit: 60 });
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
    const admin = /^\/api\/admin\/published-people\/([^/]+)$/.exec(
      url.pathname,
    );
    const detail = /^\/api\/published-people\/([^/]+)$/.exec(url.pathname);
    const search = url.pathname === "/api/published-people/search";
    if (!admin && !detail && !search) return false;

    const user = await auth.currentUser(req);
    if (!user)
      return json(res, 401, {
        error: "Войдите, чтобы искать опубликованных людей",
      });
    if (admin && (user.role !== "admin" || user.approved !== true))
      return json(res, 403, { error: "Публикация доступна администратору" });
    if (
      !admin &&
      !limiter.allow(
        requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress),
      )
    )
      return json(res, 429, { error: "Слишком много поисковых запросов" });
    if (
      req.method !== "GET" &&
      (!admin || !isSameOriginRequest(req, publicOrigin))
    )
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (!admin && req.method !== "GET")
      return json(res, 405, { error: "Метод не поддерживается" });

    const snapshot = await archive.read();
    if (search) {
      const query = (url.searchParams.get("q") || "").trim();
      if (req.method !== "GET")
        return json(res, 405, { error: "Метод не поддерживается" });
      if (query.length < 2 || query.length > 100)
        return json(res, 400, {
          error: "Введите от 2 до 100 символов для поиска",
        });
      const ids = await store.ids();
      const terms = query
        .toLocaleLowerCase("ru-RU")
        .split(/\s+/)
        .filter(Boolean);
      const results = snapshot.family.people
        .filter((person) => ids.has(person.id) && publishablePerson(person))
        .map(publicPerson)
        .filter((person) => {
          const searchable = [
            person.name,
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
          await store.publish(personId, user.id);
        } else await store.unpublish(personId);
      } else if (req.method !== "GET") {
        return json(res, 405, { error: "Метод не поддерживается" });
      }
      return json(res, 200, {
        archiveId: archive.db.kind === "postgres" ? archive.db.archiveId : null,
        published: await store.has(personId),
        publishable: publishablePerson(person),
        person: publicPerson(person),
      });
    }
    if (!publishablePerson(person) || !(await store.has(personId)))
      return json(res, 404, { error: "Человек не найден" });
    return json(res, 200, { person: publicPerson(person) });
  };
}
