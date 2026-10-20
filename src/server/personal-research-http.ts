import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { personalResearchStore, bookmarkTarget } from "./personal-research.ts";
import { projectFamilyForUser } from "../domain/tree-access.ts";
import { memberPreviewTarget } from "./member-preview-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { researchRequestBody } from "./research-request-body.ts";
import {
  AccountSessionExpired,
  AccountSessionBusy,
  assertActiveAccountSession,
} from "./account-session-guard.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { ForbiddenError } from "./users.ts";

class PersonalTargetMissing extends Error {}

export function personalResearchHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const store = personalResearchStore(archive.db);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (
      url.pathname !== "/api/bookmarks" &&
      url.pathname !== "/api/people-filters"
    )
      return false;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    const initial = await auth.currentUser(req);
    if (!initial?.approved || memberPreviewTarget(req))
      return json(401, { error: "Войдите, чтобы открыть личные сохранения" });
    if (req.method !== "GET" && req.method !== "POST")
      return json(405, { error: "Ожидается GET или POST" });
    if (req.method === "POST" && !isSameOriginRequest(req, publicOrigin))
      return json(403, { error: "Недопустимый источник запроса" });
    try {
      const body =
        req.method === "POST" ? await researchRequestBody(req) : null;
      const checkUser = async (writing: boolean) => {
        if (!auth.local) {
          const session = await auth.accountSession(req);
          if (!session || session.accountId !== initial.id)
            throw new AccountSessionExpired("Сеанс завершён");
          await assertActiveAccountSession(
            archive.db,
            initial.id,
            session.tokenHash,
          );
          if (archive.db.kind === "postgres") {
            // Serialize per-user limits across tabs and instances; no graph write.
            const member = await archive.db
              .prepare(
                "",
                `SELECT 1 FROM archive_memberships WHERE archive_id=? AND user_id=? FOR ${writing ? "UPDATE" : "SHARE"} NOWAIT`,
              )
              .get(archive.db.archiveId!, initial.id);
            if (!member) throw new ForbiddenError("Доступ к древу отозван");
          }
        }
        const user = await auth.currentUser(req);
        if (!user?.approved || user.id !== initial.id)
          throw new ForbiddenError("Доступ к древу отозван");
        if (archive.db.kind === "postgres")
          await archive.db
            .prepare("", "SELECT set_config('drevo.account_id',?,true)")
            .get(user.id);
        return user;
      };
      const scope = (user: Awaited<ReturnType<typeof checkUser>>) =>
        JSON.stringify([user.id, user.role, user.treeAccess, user.personId]);
      const prepared = await archive.db.transaction(
        async () => {
          const user = await checkUser(!!body);
          const bookmarks = url.pathname === "/api/bookmarks";
          const snapshot =
            bookmarks || (body && body.remove !== true)
              ? await archive.read()
              : null;
          const family = snapshot
            ? projectFamilyForUser(snapshot.family, user)
            : null;
          if (body) {
            if (bookmarks) {
              if (body.clearUnavailable === true) {
                const targets = await store.bookmarks(user.id);
                const visible = new Set(
                  (await store.resolve(targets, family!, user)).map(
                    (item) => `${item.kind}:${item.id}`,
                  ),
                );
                await store.removeBookmarks(
                  user.id,
                  targets.filter(
                    (item) => !visible.has(`${item.kind}:${item.id}`),
                  ),
                );
              } else {
                if (typeof body.remove !== "boolean")
                  throw new Error("Укажите действие с закладкой");
                const target = bookmarkTarget(body);
                if (
                  !body.remove &&
                  !(await store.resolve([target], family!, user)).length
                )
                  throw new PersonalTargetMissing(
                    "Объект не найден или недоступен",
                  );
                await store.bookmark(user.id, target, body.remove);
              }
            } else if (body.remove === true)
              await store.deleteFilter(user.id, body.id);
            else
              await store.saveFilter(
                user.id,
                body.name,
                body.criteria,
                family!,
              );
          }
          const targets = bookmarks ? await store.bookmarks(user.id) : [];
          const visible = bookmarks
            ? await store.resolve(targets, family!, user)
            : [];
          const result = bookmarks
            ? {
                items: visible,
                unavailable: targets.length - visible.length,
              }
            : { items: await store.filters(user.id) };
          return {
            result,
            scope: scope(user),
            revision: (snapshot || (await archive.meta())).revision,
          };
        },
        false,
        { archiveLock: "share", graphReadOnly: true },
      );
      // Personal mutations are committed before acknowledging them. Recheck the
      // current grant and graph before handing any resolved labels to HTTP.
      return await archive.db.transaction(
        async () => {
          const user = await checkUser(false);
          if (
            scope(user) !== prepared.scope ||
            (await archive.meta()).revision !== prepared.revision
          )
            return json(409, {
              error: "Доступ или архив изменились. Повторите загрузку",
            });
          const delivered = finished(res, { cleanup: true });
          const timeout = setTimeout(() => res.destroy(), 5_000);
          timeout.unref();
          try {
            json(200, prepared.result);
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
      return json(
        error instanceof PersonalTargetMissing
          ? 404
          : error instanceof ForbiddenError
            ? 403
            : error instanceof AccountSessionExpired
              ? 401
              : error instanceof AccountSessionBusy ||
                  (error as { code?: string }).code === "55P03"
                ? 409
                : 400,
        {
          error:
            error instanceof Error ? error.message : "Не удалось сохранить",
        },
      );
    }
  };
}
