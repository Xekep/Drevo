import type { IncomingMessage, ServerResponse } from "node:http";
import {
  validatedChanges,
  type Change,
} from "../domain/changes.ts";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";

const MAX_CHANGES = 10_000;
const MAX_BODY = 8 * 1024 * 1024;
const unsafeFields = new Set(["__proto__", "prototype", "constructor"]);

function parseChanges(value: unknown): Change[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Ожидается объект с изменениями");
  const raw = (value as { changes?: unknown }).changes;
  if (!Array.isArray(raw)) throw new Error("Ожидается список изменений");
  if (raw.length > MAX_CHANGES) throw new Error("Слишком много изменений");

  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`Некорректное изменение #${index + 1}`);
    const record = item as Record<string, unknown>,
      collection = record.collection;
    if (!["people", "links", "photos", "meta"].includes(String(collection)))
      throw new Error(`Некорректная коллекция в изменении #${index + 1}`);

    const id = record.id,
      field = record.field;
    if (collection === "meta") {
      if (id !== undefined)
        throw new Error(`Лишний id в изменении метаданных #${index + 1}`);
      if (!["title", "description", "demo"].includes(String(field)))
        throw new Error(`Некорректное поле метаданных #${index + 1}`);
    } else {
      if (typeof id !== "string" || !id || id.length > 200)
        throw new Error(`Некорректный id в изменении #${index + 1}`);
      if (
        field !== undefined &&
        (typeof field !== "string" ||
          !field ||
          field.length > 100 ||
          unsafeFields.has(field))
      )
        throw new Error(`Некорректное поле в изменении #${index + 1}`);
    }

    return {
      collection: collection as Change["collection"],
      ...(id !== undefined ? { id: String(id) } : {}),
      ...(field !== undefined ? { field: String(field) } : {}),
      before: Object.hasOwn(record, "before") ? record.before : undefined,
      after: Object.hasOwn(record, "after") ? record.after : undefined,
    };
  });
}

export function familyChangesHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  publicOrigin?: string;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const conflict = (res: ServerResponse) =>
    json(res, 409, {
      error: "Архив изменён в другой вкладке. Обновите данные перед сохранением.",
    });

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/api/family/changes") return false;
    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, {
        error: "Сохранение разрешено только со страницы архива",
      });
    if (!auth.canEdit(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "You do not have editing access",
      });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "Ожидается JSON" });

    const revision = Number(req.headers["if-match"]);
    if (
      req.headers["if-match"] === undefined ||
      !Number.isInteger(revision) ||
      revision < 0
    )
      return json(res, 428, { error: "Не указана версия архива" });
    if (archive.meta().revision !== revision) return conflict(res);

    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY)
          return json(res, 413, { error: "Максимальный размер — 8 МБ" });
        chunks.push(Buffer.from(chunk));
      }
      const actor = auth.currentUser(req);
      if (!actor || actor.role === "reader")
        throw new ForbiddenError("Editing access is no longer available");

      const current = archive.read();
      if (current.revision !== revision) return conflict(res);
      const changes = parseChanges(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!changes.length) return json(res, 200, current);

      const merged = validatedChanges(current.family, changes);
      if (merged.conflicts.length) return conflict(res);
      return json(
        res,
        200,
        archive.write(merged.family, revision, actor),
      );
    } catch (error) {
      return json(
        res,
        error instanceof ConflictError
          ? 409
          : error instanceof ForbiddenError
            ? 403
            : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось сохранить изменения",
        },
      );
    }
  };
}
