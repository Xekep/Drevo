import type { IncomingMessage, ServerResponse } from "node:http";
import {
  validatedChanges,
  archiveChanges,
  type Change,
} from "../domain/changes.ts";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";

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
    if (
      !["people", "links", "unions", "photos", "meta"].includes(
        String(collection),
      )
    )
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
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
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
      error:
        "Архив изменён в другой вкладке. Обновите данные перед сохранением.",
    });

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const delta = url.pathname === "/api/family/changes",
      full = url.pathname === "/api/family" && req.method === "PUT";
    if (!delta && !full) return false;
    if (delta && req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, {
        error: "Сохранение разрешено только со страницы архива",
      });
    if (!(await auth.canEdit(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
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

    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY)
          return json(res, 413, { error: "Максимальный размер — 8 МБ" });
        chunks.push(Buffer.from(chunk));
      }
      const actor = await auth.currentUser(req);
      if (!actor || actor.role === "reader")
        throw new ForbiddenError("Editing access is no longer available");
      if (full && isScopedUser(actor))
        throw new ForbiddenError(
          "Используйте сохранение отдельных изменений для ограниченного древа",
        );

      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (full)
        return json(res, 200, await archive.write(body, revision, actor));

      const changes = parseChanges(body);
      const patched = await archive.patchPeople(changes, revision, actor);
      if (patched) {
        if (
          req.headers.prefer === "return=minimal" &&
          patched.baseRevision === revision
        ) {
          res.setHeader("Preference-Applied", "return=minimal");
          return json(res, 200, patched);
        }
        return json(res, 200, {
          ...patched,
          family: projectFamilyForUser((await archive.read()).family, actor),
        });
      }
      const current = await archive.read();
      if (revision > current.revision) return conflict(res);
      if (!changes.length)
        return json(res, 200, {
          ...current,
          appliedChanges: [],
          family: projectFamilyForUser(current.family, actor),
        });

      const merged = validatedChanges(current.family, changes);
      if (merged.conflicts.length) return conflict(res);
      const saved = await archive.write(
        merged.family,
        current.revision,
        actor,
        undefined,
        current.family,
      );
      return json(res, 200, {
        ...saved,
        appliedChanges: archiveChanges(current.family, saved.family),
        family: projectFamilyForUser(saved.family, actor),
      });
    } catch (error) {
      if (isInfrastructureError(error)) throw error;
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
              : full
                ? "Не удалось сохранить данные"
                : "Не удалось сохранить изменения",
        },
      );
    }
  };
}
