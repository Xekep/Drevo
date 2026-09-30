import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { imagePreviews, ImagePreviewVariant } from "./image-previews.ts";
import type { mediaStore } from "./media.ts";
import type { settingsStore } from "./settings.ts";
import type { openArchive } from "./database.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { ownsPendingMedia } from "./media-access.ts";

export function mediaHttp({
  auth,
  media,
  previewImage,
  visibility,
  archive,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  archive: Awaited<ReturnType<typeof openArchive>>;
}) {
  let cachedKey = "",
    cachedUrls = new Set<string>();
  const referenced = async (url: string, includePortraits: boolean) => {
    if (
      await archive.db
        .prepare(
          "SELECT 1 FROM photos WHERE json_extract(data,'$.url')=? LIMIT 1",
          "SELECT 1 FROM photos WHERE (data->>'url')=? LIMIT 1",
        )
        .get(url)
    )
      return true;
    return (
      includePortraits &&
      !!(await archive.db
        .prepare(
          "SELECT 1 FROM people WHERE json_extract(data,'$.photo')=? LIMIT 1",
          "SELECT 1 FROM people WHERE (data->>'photo')=? LIMIT 1",
        )
        .get(url))
    );
  };
  const permitted = async (req: IncomingMessage, url?: string) => {
    const canRead = await auth.canRead(req);
    if (!canRead && !(await visibility.read()).publicAlbums) return false;
    if (!url) return false;
    if (!canRead) {
      // UUID is an identifier, not permission to view an unpublished upload.
      const settings = await visibility.read();
      return await referenced(url, settings.publicTree);
    }
    const user = await auth.currentUser(req);
    if (!user) return false;
    if (await ownsPendingMedia(archive.db, url, user.id)) return true;
    if (!isScopedUser(user)) return await referenced(url, true);
    const key = `${(await archive.meta()).revision}:${user.id}:${user.personId || ""}`;
    if (key !== cachedKey) {
      const scoped = projectFamilyForUser((await archive.read()).family, user);
      cachedUrls = new Set([
        ...scoped.people
          .map((person) => person.photo)
          .filter((photo): photo is string => !!photo),
        ...(scoped.photos || []).map((photo) => photo.url),
      ]);
      cachedKey = key;
    }
    return cachedUrls.has(url);
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/media/") || req.method !== "GET")
      return false;
    if (!(await permitted(req, url.pathname)))
      return json(res, 401, { error: "Sign in to view this archive" });

    const file = media.open(url.pathname);
    if (!file) return json(res, 404, { error: "Фото не найдено" });
    const requested = url.searchParams.get("variant");
    const variant: ImagePreviewVariant | null =
      requested === "thumb" || requested === "display" ? requested : null;

    if (variant && file.type !== "image/gif") {
      try {
        const bytes = await previewImage(
          { path: file.path, cacheKey: file.name },
          variant,
        );
        if (!(await permitted(req, url.pathname)))
          return json(res, 401, { error: "Доступ к фотографиям закрыт" });
        res.writeHead(200, {
          "Content-Type": "image/webp",
          "Content-Length": String(bytes.length),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        });
        res.end(bytes);
        return true;
      } catch {
        /* Если превью не удалось получить, отдаём исходный снимок. */
      }
    }

    let handle: FileHandle | undefined;
    try {
      handle = await openFile(file.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return json(res, 404, { error: "Фото не найдено" });
      }
      if (!(await permitted(req, url.pathname))) {
        await handle.close();
        return json(res, 401, { error: "Доступ к фотографиям закрыт" });
      }
      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": String(stat.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      try {
        await pipeline(handle.createReadStream(), res);
      } catch {
        if (!res.destroyed) res.destroy();
      }
      return true;
    } catch {
      if (handle) await handle.close().catch(() => {});
      if (!res.headersSent) return json(res, 404, { error: "Фото не найдено" });
      if (!res.destroyed) res.destroy();
      return true;
    }
  };
}
