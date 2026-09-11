import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { mediaStore } from "./media.ts";
import type { imagePreviews } from "./image-previews.ts";
import type { settingsStore } from "./settings.ts";
import type { sharesStore } from "./shares.ts";
import { sharedFamily } from "../domain/shared-family.ts";

export function publicSharingHttp({
  archive,
  media,
  previewImage,
  visibility,
  shares,
}: {
  archive: ReturnType<typeof openArchive>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: ReturnType<typeof settingsStore>;
  shares: ReturnType<typeof sharesStore>;
}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (!path.startsWith("/api/shared/")) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    const shared =
      /^\/api\/shared\/([A-Za-z0-9_-]{43})(?:\/portrait\/([^/]+))?$/.exec(path);
    if (req.method !== "GET")
      return json(405, { error: "Доступен только просмотр" });
    const share = shared && shares.get(shared[1]);
    if (!share)
      return json(410, {
        error: "Ссылка недействительна, отозвана или срок её действия истёк.",
      });
    const { family } = archive.read();
    if (shared![2]) {
      const token = shared![1],
        id = decodeURIComponent(shared![2]);
      const person =
        share.personIds.includes(id) && family.people.find((p) => p.id === id);
      const file =
        person && person.photo?.startsWith("/media/")
          ? media.open(person.photo)
          : null;
      if (!file) return json(404, { error: "Портрет не найден" });

      if (file.type !== "image/gif") {
        try {
          const bytes = await previewImage(
            { path: file.path, cacheKey: file.name },
            "thumb",
          );
          if (!shares.get(token))
            return json(410, { error: "Срок ссылки истёк" });
          res.writeHead(200, {
            "Content-Type": "image/webp",
            "Content-Length": String(bytes.length),
            "X-Content-Type-Options": "nosniff",
          });
          res.end(bytes);
          return true;
        } catch {
          /* Если превью не удалось получить, потоково отдаём исходный файл. */
        }
      }

      let handle;
      try {
        handle = await openFile(file.path, "r");
        const stat = await handle.stat();
        if (!stat.isFile()) {
          await handle.close();
          return json(404, { error: "Портрет не найден" });
        }
        if (!shares.get(token)) {
          await handle.close();
          return json(410, { error: "Срок ссылки истёк" });
        }
        res.writeHead(200, {
          "Content-Type": file.type,
          "Content-Length": String(stat.size),
          "X-Content-Type-Options": "nosniff",
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
          return json(404, { error: "Портрет не найден" });
        if (!res.destroyed) res.destroy();
        return true;
      }
    }
    return json(200, {
      family: sharedFamily(family, share, shared![1]),
      expiresAt: share.expiresAt,
      serverTime: new Date().toISOString(),
      reverseTimeline: visibility.read().reverseTimeline,
    });
  };
}
