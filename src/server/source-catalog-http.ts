import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { readArchive } from "./database.ts";
import { assertCurrentArchiveActor } from "./users.ts";
import { allCitations, sourceCatalogStore } from "./source-catalog-store.ts";
import { parseCatalogSource, sourceCitation } from "../shared/source-catalog.ts";

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function sourceCatalogHttp(
  archive: Awaited<ReturnType<typeof openArchive>>,
  auth: Awaited<ReturnType<typeof createAuth>>,
  publicOrigin?: string,
) {
  const db = archive.db;
  const catalog = sourceCatalogStore(db);
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
    return true;
  };
  const bumpRevision = async () => await db.prepare(
    "UPDATE archive SET revision=revision+1 WHERE id=1",
    "UPDATE archives SET revision=revision+1 WHERE id=current_setting('drevo.archive_id', true)",
  ).run();
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const match = /^\/api\/sources(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/links)?)?$/.exec(url.pathname);
    if (!match) return false;
    const linksRoute = url.pathname.endsWith("/links");
    if (!await auth.isAdmin(req)) return json(res, 403, { error: "Каталог источников доступен администратору архива" });
    if (req.method === "GET" && !match[1]) {
      return json(res, 200, { sources: await catalog.list() });
    }
    if (req.method === "GET" && match[1] && !linksRoute) {
      const source = await catalog.get(match[1]);
      return source ? json(res, 200, { source }) : json(res, 404, { error: "Источник не найден" });
    }
    const actor = await auth.currentUser(req);
    if (!actor || !await auth.canEdit(req)) return json(res, 403, { error: "Недостаточно прав" });
    if (!isSameOriginRequest(req, publicOrigin)) return json(res, 403, { error: "Недопустимый источник запроса" });
    let input: Record<string, unknown>;
    try { input = await body(req); }
    catch { return json(res, 400, { error: "Некорректный JSON" }); }
    const id = match[1];
    if (req.method === "POST" && !id) {
      const source = parseCatalogSource({
        title: "", type: "", author: "", institution: "", archive: "",
        fond: "", opis: "", delo: "", sheet: "", reference: "",
        url: "", accessedAt: "", description: "", documentIds: [],
        ...input, id: randomUUID(),
      });
      if (!source) return json(res, 400, { error: "Проверьте реквизиты источника" });
      try {
        await db.transaction(async () => {
          await assertCurrentArchiveActor(db, actor);
          if (!await catalog.documentIdsExist(source.documentIds)) throw new Error("Документ отсутствует в архиве");
          await catalog.insert(source);
          await bumpRevision();
        });
        return json(res, 201, { source: { ...source, version: 1 } });
      } catch (error) { return json(res, 400, { error: (error as Error).message }); }
    }
    if (!id) return json(res, 405, { error: "Неизвестная операция" });
    if ((req.method === "POST" || req.method === "DELETE") && linksRoute) {
      if (typeof input.personId !== "string" ||
        (input.eventId !== undefined && typeof input.eventId !== "string") ||
        !Number.isSafeInteger(input.revision))
        return json(res, 400, { error: "Выберите факт и версию архива" });
      const source = await catalog.get(id);
      if (!source) return json(res, 404, { error: "Источник не найден" });
      const current = await archive.read();
      const person = current.family.people.find((item) => item.id === input.personId);
      const event = input.eventId && person?.events?.find((item) => item.id === input.eventId);
      if (!person || (input.eventId && !event)) return json(res, 404, { error: "Факт не найден" });
      const citations = event ? event.sources || [] : person.sources;
      const index = citations.findIndex((item) => item.catalogId === id);
      if (req.method === "POST") {
        const documentId = input.documentId === undefined ? source.documentIds[0] : input.documentId;
        if ((documentId !== undefined &&
          (typeof documentId !== "string" || !source.documentIds.includes(documentId))) ||
          (input.documentPage !== undefined &&
            (!documentId || !Number.isInteger(input.documentPage) ||
              (input.documentPage as number) < 1 || (input.documentPage as number) > 2000)))
          return json(res, 400, { error: "Страница должна принадлежать документу источника" });
        if (index >= 0) return json(res, 409, { error: "Источник уже привязан" });
        if (citations.length >= 50) return json(res, 400, { error: "Слишком много источников" });
        citations.push({ ...sourceCitation(source),
          ...(documentId ? { documentId } : {}),
          ...(input.documentPage ? { documentPage: input.documentPage as number } : {}),
        });
      } else {
        if (index < 0) return json(res, 404, { error: "Связь не найдена" });
        citations.splice(index, 1);
      }
      try {
        const result = await archive.write(current.family, input.revision as number, actor,
          req.method === "POST" ? "Привязан источник" : "Удалена связь с источником");
        return json(res, 200, { revision: result.revision });
      } catch (error) { return json(res, 409, { error: (error as Error).message }); }
    }
    if (linksRoute) return json(res, 405, { error: "Неизвестная операция" });
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 1)
      return json(res, 400, { error: "Нужна версия источника" });
    if (req.method === "PUT") {
      const previous = await catalog.get(id);
      if (!previous) return json(res, 404, { error: "Источник не найден" });
      const source = parseCatalogSource({ ...previous, ...input, id });
      if (!source) return json(res, 400, { error: "Проверьте реквизиты источника" });
      try {
        const changed = await db.transaction(async () => {
          await assertCurrentArchiveActor(db, actor);
          if (!await catalog.documentIdsExist(source.documentIds)) throw new Error("Документ отсутствует в архиве");
          const result = await catalog.update(source, input.version as number);
          if (result.changes) await bumpRevision();
          return result.changes;
        });
        return changed ? json(res, 200, { source: { ...source, version: (input.version as number) + 1 } })
          : json(res, 409, { error: "Источник изменён в другой вкладке" });
      } catch (error) { return json(res, 400, { error: (error as Error).message }); }
    }
    if (req.method === "DELETE") {
      const result = await db.transaction(async () => {
        await assertCurrentArchiveActor(db, actor);
        const family = (await readArchive(db)).family;
        if (allCitations(family).some((source) => source.catalogId === id)) return "linked";
        const deleted = await catalog.remove(id, input.version as number);
        if (deleted.changes) await bumpRevision();
        return deleted.changes ? "deleted" : "stale";
      });
      return result === "deleted" ? json(res, 200, { deleted: true }) :
        json(res, 409, { error: result === "linked" ? "Источник связан с фактом" : "Источник изменён в другой вкладке" });
    }
    return json(res, 405, { error: "Неизвестная операция" });
  };
}
