import type { IncomingMessage, ServerResponse } from "node:http";
import { statfs } from "node:fs/promises";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { MediaTooLargeError, type mediaStore } from "./media.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";
import { projectFamilyForUser } from "../domain/tree-access.ts";
import { canEditArchive } from "../domain/access.ts";
import { registerMediaUpload } from "./media-access.ts";
import { uploadQuota, UploadQuotaError } from "./upload-quota.ts";
import {
  AccountSessionBusy,
  AccountSessionExpired,
  assertActiveAccountSession,
} from "./account-session-guard.ts";

const MAX_UPLOAD = 20 * 1024 * 1024;

function photoFields(req: IncomingMessage) {
  const metadata = JSON.parse(
    decodeURIComponent(String(req.headers["x-photo-metadata"] || "%7B%7D")),
  );
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Некорректное описание фотографии");
  const fields: Record<string, string> = {};
  for (const key of ["title", "year", "place", "event", "description"])
    if ((metadata as Record<string, unknown>)[key] !== undefined) {
      const value = (metadata as Record<string, unknown>)[key];
      if (typeof value !== "string" || value.length > 1000)
        throw new Error("Слишком длинное описание фотографии");
      if (value.trim()) fields[key] = value.trim();
    }
  return fields;
}

export function mediaUploadHttp({
  archive,
  auth,
  media,
  publicOrigin,
  uploadsDirectory,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  media: ReturnType<typeof mediaStore>;
  publicOrigin?: string;
  uploadsDirectory: string;
}) {
  const quota = uploadQuota(archive.db);
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
      error: "Архив изменился. Обновите древо и повторите загрузку.",
    });

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const portrait = url.pathname === "/api/portraits";
    if (!portrait && url.pathname !== "/api/photos") return false;
    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, {
        error: "Сохранение разрешено только со страницы архива",
      });
    const initiallyAllowed = await auth.canEdit(req);
    const requester = await auth.currentUser(req);
    const issuingSession = !auth.local ? await auth.accountSession(req) : null;
    if (!requester || !initiallyAllowed || !canEditArchive(requester) ||
        (!auth.local &&
          (!issuingSession || issuingSession.accountId !== requester.id)))
      return json(res,
        !auth.local
          ? issuingSession ? 403 : 401
          : requester ? 403 : 401,
        { error: "Нет прав на изменение архива" },
      );
    if (req.headers["x-drevo-upload"] !== "1")
      return json(res, 400, { error: "Некорректная загрузка" });

    const revision = Number(req.headers["if-match"]);
    if (
      req.headers["if-match"] === undefined ||
      !Number.isInteger(revision) ||
      revision < 0
    )
      return json(res, 428, { error: "Не указана версия архива" });
    if ((await archive.meta()).revision !== revision) return conflict(res);

    let file: Awaited<ReturnType<typeof media.addStream>> | undefined;
    let forgetUpload: (() => unknown) | undefined;
    let release: (() => Promise<unknown>) | undefined;
    let committed = false;
    try {
      release = await quota.acquire(
        requester.id,
        Number(req.headers["content-length"]) > 0
          ? Math.min(Number(req.headers["content-length"]), MAX_UPLOAD)
          : MAX_UPLOAD,
        async () => {
          const disk = await statfs(uploadsDirectory);
          return disk.bavail * disk.bsize;
        },
        () => media.usage(true),
      );
      file = await media.addStream(req, MAX_UPLOAD);
      const actor = await auth.currentUser(req);
      if (!actor && issuingSession)
        await assertActiveAccountSession(archive.db, requester.id, issuingSession.tokenHash);
      if (
        !actor?.approved ||
        actor.role === "reader" ||
        actor.id !== requester.id
      )
        throw new ForbiddenError("Доступ к изменению архива утрачен");
      if ((await archive.meta()).revision !== revision) {
        await file.undo();
        file = undefined;
        return conflict(res);
      }

      const fields = portrait ? null : photoFields(req);
      const writePhoto = async (withinTransaction: boolean) => {
        const current = (await archive.read()).family;
        return archive.write(
          {
            ...current,
            photos: [
              ...(current.photos || []),
              {
                id: file!.id,
                url: file!.url,
                title: "",
                ...fields,
                createdAt: new Date().toISOString(),
                tags: [],
              },
            ],
          },
          revision,
          actor,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { withinTransaction },
        );
      };
      let value: unknown;
      const assertCurrentActor = async () => {
        if (archive.db.kind === "postgres") {
          await assertCurrentArchiveActor(archive.db, actor);
          return;
        }
        // The serialized SQLite transaction retains this user/session snapshot
        // through commit; the PostgreSQL actor guard does not cover SQLite.
        const current = await auth.currentUser(req);
        if (!current || current.id !== actor.id ||
            current.approved !== actor.approved || current.role !== actor.role ||
            (current.personId || "") !== (actor.personId || "") ||
            (current.treeAccess || "all") !== (actor.treeAccess || "all") ||
            !canEditArchive(current))
          throw new ForbiddenError("Доступ к изменению архива утрачен");
      };
      if (!auth.local) {
        if (!issuingSession || issuingSession.accountId !== actor.id)
          throw new AccountSessionExpired("Сеанс завершён. Войдите снова.");
        value = await archive.db.transaction(async () => {
          await assertActiveAccountSession(archive.db, actor.id, issuingSession.tokenHash);
          await assertCurrentActor();
          await registerMediaUpload(archive.db, file!.url, actor.id, file!.size,
            { withinTransaction: true });
          const result = portrait ? null : await writePhoto(true);
          const response = portrait ? { url: file!.url } : {
            ...result,
            family: projectFamilyForUser(result!.family, actor),
          };
          await assertActiveAccountSession(archive.db, actor.id, issuingSession.tokenHash);
          if (archive.db.kind === "sqlite") await assertCurrentActor();
          return response;
        });
      } else {
        forgetUpload = await registerMediaUpload(archive.db, file.url, actor.id, file.size);
        if (portrait) {
          committed = true;
          value = { url: file.url };
        } else {
          const result = await writePhoto(false);
          committed = true;
          value = { ...result, family: projectFamilyForUser(result.family, actor) };
        }
      }
      committed = true;
      if (auth.local) return json(res, 201, value);
      const body = JSON.stringify(value);
      try {
        return await archive.db.transaction(async () => {
          await assertActiveAccountSession(archive.db, actor.id, issuingSession!.tokenHash);
          await assertCurrentActor();
          if (!portrait && (await archive.meta()).revision !==
              (value as { revision: number }).revision)
            throw new ConflictError("Архив изменился до выдачи фотографии");
          if (res.destroyed) return true;
          const timeout = setTimeout(() => res.destroy(), 5_000);
          timeout.unref();
          let delivered: Promise<void> | undefined;
          try {
            res.writeHead(201, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            });
            delivered = finished(res, { cleanup: true });
            res.end(body);
            await delivered;
          } catch (error) {
            if (!res.headersSent && !res.destroyed) throw error;
            res.destroy();
            await delivered?.catch(() => {});
          } finally {
            clearTimeout(timeout);
          }
          return true;
        });
      } catch (error) {
        if (res.destroyed || res.headersSent) return true;
        if (error instanceof ConflictError ||
            error instanceof AccountSessionBusy ||
            (error as { code?: string }).code === "55P03")
          return json(res, 201, { committed: true, refreshRequired: true });
        if (error instanceof AccountSessionExpired ||
            error instanceof ForbiddenError)
          return json(res, 201, { committed: true, accessChanged: true });
        throw error;
      }
    } catch (error) {
      // A response/projection failure cannot roll back archive.write. Keep
      // its original and quota metadata once the graph references the photo.
      if (committed) {
        if (res.destroyed) return true;
        if (res.headersSent) {
          res.destroy();
          return true;
        }
        return json(res, 500, { error: "Фото сохранено. Обновите архив.", saved: true });
      }
      await forgetUpload?.();
      if (file) await file.undo();
      if (error instanceof UploadQuotaError && error.status === 429)
        res.setHeader("Retry-After", "60");
      return json(
        res,
        error instanceof AccountSessionExpired
          ? 401
          : error instanceof AccountSessionBusy
            ? 409
            : error instanceof MediaTooLargeError
              ? 413
              : error instanceof UploadQuotaError
                ? error.status
                : error instanceof ConflictError
                  ? 409
                  : error instanceof ForbiddenError
                    ? 403
                    : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось загрузить фотографию",
        },
      );
    } finally {
      await release?.();
    }
  };
}
