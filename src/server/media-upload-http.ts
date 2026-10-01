import type { IncomingMessage, ServerResponse } from "node:http";
import { statfs } from "node:fs/promises";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { MediaTooLargeError, type mediaStore } from "./media.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";
import { projectFamilyForUser } from "../domain/tree-access.ts";
import { registerMediaUpload } from "./media-access.ts";
import { uploadQuota, UploadQuotaError } from "./upload-quota.ts";

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
    if (!(await auth.canEdit(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "You do not have editing access",
      });
    const requester = (await auth.currentUser(req))!;
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
      if (
        !actor?.approved ||
        actor.role === "reader" ||
        actor.id !== requester.id
      )
        throw new ForbiddenError("Editing access is no longer available");
      if ((await archive.meta()).revision !== revision) {
        await file.undo();
        file = undefined;
        return conflict(res);
      }

      forgetUpload = await registerMediaUpload(
        archive.db,
        file.url,
        actor.id,
        file.size,
      );
      if (portrait) return json(res, 201, { url: file.url });

      const current = (await archive.read()).family,
        fields = photoFields(req);
      try {
        const result = await archive.write(
          {
            ...current,
            photos: [
              ...(current.photos || []),
              {
                id: file.id,
                url: file.url,
                title: "",
                ...fields,
                createdAt: new Date().toISOString(),
                tags: [],
              },
            ],
          },
          revision,
          actor,
        );
        return json(res, 201, {
          ...result,
          family: projectFamilyForUser(result.family, actor),
        });
      } catch (error) {
        await file.undo();
        file = undefined;
        throw error;
      }
    } catch (error) {
      await forgetUpload?.();
      if (file) await file.undo();
      if (error instanceof UploadQuotaError && error.status === 429)
        res.setHeader("Retry-After", "60");
      return json(
        res,
        error instanceof MediaTooLargeError
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
