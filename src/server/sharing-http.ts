import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { mediaStore } from "./media.ts";
import type { imagePreviews } from "./image-previews.ts";
import type { settingsStore } from "./settings.ts";
import { userStore } from "./users.ts";
import { sharesStore } from "./shares.ts";
import { auditStore } from "./audit.ts";
import { adminAccessHttp } from "./admin-access-http.ts";
import { adminSharingHttp } from "./admin-sharing-http.ts";
import { archiveQueryHttp } from "./archive-query-http.ts";
import { coreHttp } from "./core-http.ts";
import { databaseBackupHttp } from "./database-backup-http.ts";
import { placesHttp } from "./places-http.ts";
import { currentGeocodingStore } from "./geocoding.ts";
import { mediaHttp } from "./media-http.ts";
import { mediaUploadHttp } from "./media-upload-http.ts";
import { familyChangesHttp } from "./family-changes-http.ts";
import type { productionStaticHttp } from "./production-static-http.ts";
import { restoreHttp } from "./restore-http.ts";
import { currentRestoreStore } from "./restore.ts";
import { sharedFamily } from "../domain/shared-family.ts";

export function sharingHttp({
  archive,
  auth,
  media,
  previewImage,
  visibility,
  publicOrigin,
  serveStatic,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: ReturnType<typeof settingsStore>;
  publicOrigin?: string;
  serveStatic: ReturnType<typeof productionStaticHttp>;
}) {
  const core = coreHttp({ archive, auth, publicOrigin });
  const serveBackup = databaseBackupHttp({ archive, auth });
  const adminAccess = adminAccessHttp({
    auth,
    users: userStore(archive.db),
    visibility,
    publicOrigin,
  });
  const archiveQuery = archiveQueryHttp({ archive, auth, visibility });
  const places = placesHttp({
    archive,
    auth,
    visibility,
    geocoding: () => currentGeocodingStore(archive.db),
    publicOrigin,
  });
  const shares = sharesStore(archive.db),
    audit = auditStore(archive.db),
    adminSharing = adminSharingHttp({
      archive,
      auth,
      shares,
      audit,
      publicOrigin,
    });
  const restore = restoreHttp({
    restores: () => currentRestoreStore(archive),
    auth,
    publicOrigin,
  });
  const saveChanges = familyChangesHttp({ archive, auth, publicOrigin });
  const uploadMedia = mediaUploadHttp({ archive, auth, media, publicOrigin });
  const serveMedia = mediaHttp({ auth, media, previewImage, visibility });

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (await core(req, res, url)) return true;
    if (await serveBackup(req, res, url)) return true;
    if (await adminAccess(req, res, url)) return true;
    if (await archiveQuery(req, res, url)) return true;
    if (await places(req, res, url)) return true;
    if (await adminSharing(req, res, url)) return true;
    if (await restore(req, res, url)) return true;
    if (await saveChanges(req, res, url)) return true;
    if (await uploadMedia(req, res, url)) return true;
    if (await serveMedia(req, res, url)) return true;

    const path = url.pathname;
    if (!path.startsWith("/api/shared/"))
      return await serveStatic(req, res, url);
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
