import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { ForbiddenError } from "./users.ts";
import { isArchiveOwner } from "../domain/access.ts";
import { prepareTransactionUndo } from "../domain/transaction-undo.ts";
import { readArchiveOperation } from "./archive-operation-history.ts";
import type { AuditUndoPreview } from "../shared/personal-research.ts";
import { archiveAudit } from "../domain/audit.ts";
import { memberPreviewTarget } from "./member-preview-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  AccountSessionExpired,
  AccountSessionBusy,
  assertActiveAccountSession,
} from "./account-session-guard.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import {
  withPreparation,
  preparationAdmission,
  type PreparationAdmission,
} from "./preparation-admission.ts";
import { WorkQueueBusyError } from "./work-queue.ts";

export function auditUndoHttp({
  archive,
  auth,
  publicOrigin,
  preparation = preparationAdmission(),
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  preparation?: PreparationAdmission;
}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const route = url.pathname.match(
      /^\/api\/audit\/transactions\/(\d+)\/(preview|undo)$/,
    );
    if (!route) return false;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    const revision = Number(route[1]);
    const apply = route[2] === "undo";
    if (req.method !== (apply ? "POST" : "GET"))
      return json(405, { error: apply ? "Ожидается POST" : "Ожидается GET" });
    if (!Number.isSafeInteger(revision) || revision < 1)
      return json(400, { error: "Некорректная операция" });
    if (memberPreviewTarget(req) || !(await auth.isAdmin(req)))
      return json(403, { error: "Отмена доступна только владельцу древа" });
    if (apply && !isSameOriginRequest(req, publicOrigin))
      return json(403, { error: "Недопустимый источник запроса" });
    if (
      apply &&
      (req.headers["transfer-encoding"] ||
        Number(req.headers["content-length"] || 0) > 0)
    )
      return json(400, { error: "Данные операции берутся из журнала" });
    const actor = await auth.currentUser(req);
    if (!actor) return json(401, { error: "Войдите в архив" });
    const checkActor = async () => {
      if (!auth.local) {
        const session = await auth.accountSession(req);
        if (!session || session.accountId !== actor.id)
          throw new AccountSessionExpired("Сеанс завершён");
        await assertActiveAccountSession(
          archive.db,
          actor.id,
          session.tokenHash,
        );
      }
      const current = await auth.currentUser(req);
      if (
        !current?.approved ||
        current.id !== actor.id ||
        !isArchiveOwner(current)
      )
        throw new ForbiddenError("Право управления древом отозвано");
    };
    try {
      const response = await withPreparation(
        req,
        res,
        preparation,
        64 * 1024 ** 2,
        async (signal) =>
          archive.db.transaction(async () => {
            await checkActor();
            const current = await archive.read();
            const preview: AuditUndoPreview = {
              revision,
              currentRevision: current.revision,
              changes: 0,
              entries: [],
              canUndo: false,
            };
            const done = await archive.db
              .prepare(
                "SELECT reverted_revision FROM audit_reverts WHERE revision=?",
                "SELECT reverted_revision FROM audit_reverts WHERE revision=?",
              )
              .get(revision);
            if (done) preview.reason = "Эта операция уже отменена";
            else {
              try {
                const { before, after, laterChanges } =
                  await readArchiveOperation(archive.db, current, revision);
                preview.entries = archiveAudit(before, after).map(
                  ({ action, label }) => ({ action, label }),
                );
                const prepared = prepareTransactionUndo(
                  before,
                  after,
                  current.family,
                  laterChanges,
                );
                // Undo of a newly created card must not cascade away later work
                // outside Family (documents, comments or public publications).
                const remaining = new Set(
                  prepared.family.people.map((person) => person.id),
                );
                for (const person of current.family.people)
                  if (!remaining.has(person.id)) {
                    const references = await archive.db
                      .prepare(
                        `SELECT 1 AS present WHERE
                EXISTS(SELECT 1 FROM document_people WHERE person_id=?) OR
                EXISTS(SELECT 1 FROM person_comments WHERE person_id=?) OR
                EXISTS(SELECT 1 FROM published_people WHERE person_id=?)`,
                        `SELECT 1 AS present WHERE
                EXISTS(SELECT 1 FROM document_people WHERE person_id=?) OR
                EXISTS(SELECT 1 FROM person_comments WHERE person_id=?) OR
                EXISTS(SELECT 1 FROM published_people WHERE person_id=?)`,
                      )
                      .get(person.id, person.id, person.id);
                    if (references)
                      throw new Error(
                        "У добавленного человека уже есть документы, обсуждение или публикация. Удалите зависимости вручную",
                      );
                  }
                preview.changes = prepared.changes;
                preview.canUndo = true;
                if (apply) {
                  signal.throwIfAborted();
                  const expected = Number(req.headers["if-match"]);
                  if (
                    req.headers["if-match"] === undefined ||
                    !Number.isSafeInteger(expected) ||
                    expected !== current.revision
                  )
                    throw new ConflictError(
                      "Архив изменился после предпросмотра. Проверьте отмену ещё раз",
                    );
                  const saved = await archive.write(prepared.family, current.revision, actor, {
                    operation: `Отменена операция версии ${revision}`,
                    knownPrevious: current.family,
                    afterWrite: async (db) => {
                      await db
                        .prepare(
                          "INSERT INTO audit_reverts(revision,reverted_revision) VALUES(?,?)",
                          "INSERT INTO audit_reverts(revision,reverted_revision) VALUES(?,?)",
                        )
                        .run(revision, current.revision + 1);
                    },
                    withinTransaction: true,
                  });
                  return { applied: true, revision: saved.revision };
                }
              } catch (error) {
                if (
                  isInfrastructureError(error) ||
                  (error as { code?: unknown })?.code
                )
                  throw error;
                if (apply) {
                  if (
                    error instanceof ForbiddenError ||
                    error instanceof AccountSessionExpired ||
                    error instanceof ConflictError
                  )
                    throw error;
                  throw new ConflictError(
                    error instanceof Error
                      ? error.message
                      : "Отмена недоступна",
                  );
                }
                preview.reason =
                  error instanceof Error ? error.message : "Отмена недоступна";
              }
            }
            if (apply)
              throw new ConflictError(preview.reason || "Отмена недоступна");
            return preview;
          }),
      );
      // Mutation has committed. Protect its small receipt from access revocation.
      return await archive.db.transaction(
        async () => {
          await checkActor();
          const delivered = finished(res, { cleanup: true });
          const timeout = setTimeout(() => res.destroy(), 5_000);
          timeout.unref();
          try {
            json(200, response);
            await delivered;
          } catch (error) {
            if (!res.destroyed) throw error;
          } finally {
            clearTimeout(timeout);
          }
          return true;
        },
        false,
        { archiveLock: "share", graphReadOnly: true },
      );
    } catch (error) {
      if (res.headersSent || res.destroyed) return true;
      if (isInfrastructureError(error)) throw error;
      if (error instanceof WorkQueueBusyError)
        return json(503, { error: error.message });
      if ((error as { code?: unknown })?.code) throw error;
      return json(
        error instanceof ConflictError || error instanceof AccountSessionBusy
          ? 409
          : error instanceof AccountSessionExpired
            ? 401
            : error instanceof ForbiddenError
              ? 403
              : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось отменить операцию",
        },
      );
    }
  };
}
