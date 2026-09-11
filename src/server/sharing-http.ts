import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { mediaStore } from "./media.ts";
import type { imagePreviews } from "./image-previews.ts";
import type { settingsStore } from "./settings.ts";
import { sharesStore } from "./shares.ts";
import { auditStore } from "./audit.ts";
import { mediaHttp } from "./media-http.ts";
import { familyChangesHttp } from "./family-changes-http.ts";
import { sharedFamily } from "../domain/shared-family.ts";

export function sharingHttp({
  archive,
  auth,
  media,
  previewImage,
  visibility,
  publicOrigin,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: ReturnType<typeof settingsStore>;
  publicOrigin?: string;
}) {
  const saveChanges = familyChangesHttp({ archive, auth, publicOrigin });
  const serveMedia = mediaHttp({ auth, media, previewImage, visibility });
  const shares = sharesStore(archive.db),
    audit = auditStore(archive.db);
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (await saveChanges(req, res, url)) return true;
    if (await serveMedia(req, res, url)) return true;
    const path = url.pathname;
    if (
      !path.startsWith("/api/shared/") &&
      path !== "/api/audit" &&
      path !== "/api/shares" &&
      !path.startsWith("/api/shares/")
    )
      return false;
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
    if (path.startsWith("/api/shared/")) {
      if (req.method !== "GET")
        return json(405, { error: "Доступен только просмотр" });
      const share = shared && shares.get(shared[1]);
      if (!share)
        return json(410, {
          error: "Ссылка недействительна, отозвана или срок её действия истёк.",
        });
      const { family } = archive.read();
      if (shared![2]) {
        const id = decodeURIComponent(shared![2]);
        const person =
          share.personIds.includes(id) &&
          family.people.find((p) => p.id === id);
        const file =
          person && person.photo?.startsWith("/media/")
            ? media.read(person.photo)
            : null;
        if (!file) return json(404, { error: "Портрет не найден" });
        let bytes: Buffer = file.bytes;
        let type = file.type;
        if (type !== "image/gif") {
          try {
            bytes = await previewImage(file.bytes, "thumb");
            type = "image/webp";
          } catch {
            /* Исходный портрет. */
          }
        }
        if (!shares.get(shared![1]))
          return json(410, { error: "Срок ссылки истёк" });
        res.writeHead(200, {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
        });
        res.end(bytes);
        return true;
      }
      return json(200, {
        family: sharedFamily(family, share, shared![1]),
        expiresAt: share.expiresAt,
        serverTime: new Date().toISOString(),
        reverseTimeline: visibility.read().reverseTimeline,
      });
    }
    const actor = auth.currentUser(req);
    if (!actor || actor.role !== "admin")
      return json(actor ? 403 : 401, { error: "Доступно администратору" });
    if (path === "/api/audit" && req.method === "GET") {
      const before = Number(url.searchParams.get("before") || 0);
      if (!Number.isSafeInteger(before) || before < 0)
        return json(400, { error: "Некорректная страница журнала" });
      return json(
        200,
        audit.list({
          before,
          personId: url.searchParams.get("personId") || undefined,
          actorId: url.searchParams.get("actorId") || undefined,
        }),
      );
    }
    if (path === "/api/shares" && req.method === "GET") {
      const before = url.searchParams.get("before") || "";
      if (!Number.isSafeInteger(Number(before)) || Number(before) < 0)
        return json(400, { error: "Некорректная страница ссылок" });
      return json(200, shares.list(before));
    }
    if (
      (req.headers.origin &&
        req.headers.origin !==
          (publicOrigin || `http://${req.headers.host}`)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(403, { error: "Недопустимый источник запроса" });
    try {
      if (path.startsWith("/api/shares/") && req.method === "DELETE") {
        shares.revoke(
          decodeURIComponent(path.slice("/api/shares/".length)),
          actor,
        );
        return json(200, { ok: true });
      }
      if (path === "/api/shares" && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(415, { error: "Ожидается JSON" });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024)
            return json(413, { error: "Слишком большой запрос" });
          chunks.push(Buffer.from(chunk));
        }
        const currentActor = auth.currentUser(req);
        if (currentActor?.role !== "admin")
          return json(403, { error: "Доступ отозван" });
        const current = archive.read();
        if (
          !req.headers["if-match"] ||
          Number(req.headers["if-match"]) !== current.revision
        )
          return json(409, {
            error: "Архив изменился. Обновите древо и проверьте состав семьи.",
          });
        const result = shares.create(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          current.family,
          currentActor,
        );
        return json(201, { share: result.share, path: `/s/${result.token}` });
      }
      return json(405, { error: "Метод не поддерживается" });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  };
}
