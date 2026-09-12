import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { imagePreviews, ImagePreviewVariant } from "./image-previews.ts";
import type { mediaStore } from "./media.ts";
import type { settingsStore } from "./settings.ts";

export function mediaHttp({
  auth,
  media,
  previewImage,
  visibility,
}: {
  auth: ReturnType<typeof createAuth>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: ReturnType<typeof settingsStore>;
}) {
  const permitted = (req: IncomingMessage) =>
    auth.canRead(req) || visibility.read().publicAlbums;
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
    if (!permitted(req))
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
        if (!permitted(req))
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
      if (!permitted(req)) {
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
      if (!res.headersSent)
        return json(res, 404, { error: "Фото не найдено" });
      if (!res.destroyed) res.destroy();
      return true;
    }
  };
}
