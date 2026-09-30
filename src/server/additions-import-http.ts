import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADDITIONS_MAX_BYTES,
  planAdditions,
} from "../domain/additions-import.ts";
import { authorizeArchive } from "./permissions.ts";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { ForbiddenError } from "./users.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { listAdditionBatches, planUndoAdditions } from "./additions-undo.ts";
import { auditStore } from "./audit.ts";

export function additionsImportHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Pick<Awaited<ReturnType<typeof createAuth>>, "currentUser">;
  publicOrigin?: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (
      ![
        "/api/import/additions/preview",
        "/api/import/additions/apply",
        "/api/import/additions/history",
        "/api/import/additions/undo-preview",
        "/api/import/additions/undo",
      ].includes(url.pathname)
    )
      return false;
    const json = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return true;
    };
    const history = url.pathname.endsWith("/history");
    if (req.method !== (history ? "GET" : "POST"))
      return json(405, { error: "Неверный метод запроса" });
    if (!history && !isSameOriginRequest(req, publicOrigin))
      return json(403, { error: "Импорт разрешён только со страницы архива" });
    const actor = await auth.currentUser(req);
    // Same access as the existing transfer UI and GEDCOM import.
    if (!actor || actor.role !== "admin")
      return json(actor ? 403 : 401, {
        error: "Пакетный импорт доступен администратору архива",
      });
    if (history)
      return json(200, { batches: await listAdditionBatches(archive.db) });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(415, { error: "Ожидается JSON" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > ADDITIONS_MAX_BYTES)
          return json(413, { error: "Максимальный размер запроса — 8 МБ" });
        chunks.push(Buffer.from(chunk));
      }
      let body: {
        package?: unknown;
        revision?: unknown;
        fingerprint?: unknown;
        confirm?: unknown;
        importRevision?: unknown;
      };
      try {
        body = JSON.parse(
          Buffer.concat(chunks)
            .toString("utf8")
            .replace(/^\uFEFF/, ""),
        );
      } catch {
        return json(400, {
          error: "Не удалось прочитать JSON. Проверьте файл",
        });
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json(400, { error: "Ожидается объект с пакетом" });
      const current = await archive.read();
      const undo =
        url.pathname.endsWith("/undo") ||
        url.pathname.endsWith("/undo-preview");
      const apply =
        url.pathname.endsWith("/apply") || url.pathname.endsWith("/undo");
      if (
        apply &&
        (body.confirm !== true || body.revision !== current.revision)
      )
        return json(409, {
          error:
            "Архив изменился или добавление не подтверждено. Проверьте файл заново",
        });
      const plan = undo
        ? await planUndoAdditions(
            archive.db,
            current.family,
            body.importRevision,
          )
        : planAdditions(current.family, body.package, actor.id);
      authorizeArchive(plan.family, current.family, actor);
      // A content/revision checksum, not an authorization token. Works after a restart.
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            archive.db.archiveId || archive.db.file,
            actor.id,
            current.revision,
            undo ? body.importRevision : "add",
            plan.changes,
          ]),
        )
        .digest("hex");
      if (!apply)
        return json(200, {
          ...plan.preview,
          revision: current.revision,
          fingerprint,
        });
      if (body.fingerprint !== fingerprint)
        return json(409, {
          error: "Пакет изменился после проверки. Проверьте файл заново",
        });
      if (plan.preview.errorCount)
        return json(400, {
          error: undo
            ? "Отмена импорта заблокирована. Проверьте связи"
            : "В пакете есть противоречия. Добавление отменено",
          ...plan.preview,
        });
      const activeActor = await auth.currentUser(req);
      if (activeActor?.id !== actor.id || activeActor.role !== "admin")
        return json(403, {
          error: "Права изменились. Добавление отменено",
        });
      // Existing transaction rechecks revision and actor, records history and audit.
      const saved = await archive.write(
        plan.family,
        current.revision,
        activeActor,
        undo ? undefined : "import_additions",
        current.family,
        undefined,
        undo
          ? (db) =>
              auditStore(db).record(
                {
                  action: "undo_import_additions",
                  entity: "archive",
                  entityId: `import:${body.importRevision}`,
                  label: "Отмена пакетного импорта",
                  personIds: [],
                  details: [
                    {
                      field: "Импорт",
                      before: String(body.importRevision),
                      after: "Отменён",
                    },
                  ],
                },
                activeActor,
                current.revision + 1,
              )
          : undefined,
      );
      return json(200, {
        ...(undo
          ? { removed: plan.preview.people.length }
          : { added: plan.preview.people.length }),
        connections: plan.preview.connections,
        revision: saved.revision,
        existingPeopleChanged: 0,
      });
    } catch (error) {
      if (isInfrastructureError(error)) throw error;
      return json(
        error instanceof ConflictError
          ? 409
          : error instanceof ForbiddenError
            ? 403
            : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось добавить карточки",
        },
      );
    }
  };
}
