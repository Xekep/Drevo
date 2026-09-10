import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { openArchive, ConflictError } from "./database.ts";
import { removeStarterFamily } from "./demo-cleanup.ts";
import { validateFamily } from "../domain/index.ts";
import { createYandexOAuth } from "./yandex-oauth.ts";
import { userStore, ForbiddenError } from "./users.ts";
import type { Role } from "../domain/access.ts";
import { createAuth } from "./auth.ts";
import { databaseBackup } from "./backup.ts";
import { fullBackup } from "./full-backup.ts";
import { settingsStore } from "./settings.ts";
import { mediaStore } from "./media.ts";
import { restoreStore, RESTORE_LIMIT } from "./restore.ts";
import { geocodingStore } from "./geocoding.ts";
import { familyPlaces, placeKey } from "../domain/places.ts";
import { analysisExport } from "../domain/analysis-export.ts";
import { assertProductionOrigin } from "./runtime-config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const staticTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
export async function startServer(
  port = Number(process.env.PORT || 3000),
  databasePath?: string,
  production = process.argv.includes("--production"),
  oauthFetch?: typeof fetch,
) {
  assertProductionOrigin(
    process.env.NODE_ENV === "production",
    process.env.PUBLIC_ORIGIN,
  );
  const dbPath =
    databasePath ||
    process.env.DATABASE_PATH ||
    resolve(root, "data/drevo.sqlite");
  const archive = openArchive(
    dbPath,
    validateFamily(
      JSON.parse(
        readFileSync(resolve(root, "public/data/family.json"), "utf8"),
      ),
    ),
  );
  removeStarterFamily(archive);
  const media = mediaStore(resolve(dirname(dbPath), "uploads"));
  const restores = restoreStore(archive, dbPath);
  const geocoding = geocodingStore(archive.db);
  let restoreUploadBusy = false;
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  const visibility = settingsStore(archive.db);
  const users = userStore(archive.db);
  const auth = createAuth(users, publicOrigin);
  const yandex = createYandexOAuth({
    origin: publicOrigin,
    clientId: process.env.YANDEX_CLIENT_ID,
    clientSecret: process.env.YANDEX_CLIENT_SECRET,
    issueSession: auth.issueSession,
    fetcher: oauthFetch,
  });
  const snapshot = (req: IncomingMessage) => {
    const user = auth.currentUser(req),
      settings = visibility.read(),
      readTree = !!user || settings.publicTree,
      readPhotos = !!user || settings.publicAlbums;
    const data = archive.read();
    if (!readTree) {
      data.family.people = [];
      data.family.links = [];
      data.family.photos = data.family.photos?.map((p) => ({ ...p, tags: [] }));
    }
    if (!readPhotos) {
      data.family.photos = [];
      data.family.people = data.family.people.map((p) => ({
        ...p,
        photo: undefined,
      }));
    }
    return {
      ...data,
      canEdit: auth.canEdit(req),
      local: auth.local,
      user,
      readTree,
      readPhotos,
      reverseTimeline: settings.reverseTimeline,
    };
  };
  const vite = production
    ? null
    : await (
        await import("vite")
      ).createServer({
        root,
        configFile: resolve(root, "vite.config.ts"),
        server: {
          middlewareMode: true,
          fs: {
            deny: [
              ".env",
              ".env.*",
              "**/*.sqlite*",
              "**/data/**",
              "**/server/**",
              "**/.git/**",
            ],
          },
        },
        appType: "spa",
      });
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host || "",
      origin = req.headers.origin;
    if (
      !/^(127\.0\.0\.1|localhost):\d+$/.test(host) &&
      !(publicOrigin && host === new URL(publicOrigin).host)
    )
      return json(res, 403, { error: "Неизвестный адрес архива" });
    const parsedUrl = new URL(req.url || "/", `http://${host}`),
      url = parsedUrl.pathname;
    if (await yandex.handle(req, res, parsedUrl)) return;
    if (url === "/api/session" && req.method === "GET")
      return json(res, 200, {
        canEdit: auth.canEdit(req),
        local: auth.local,
        yandex: yandex.enabled,
        user: auth.currentUser(req),
      });
    if (url === "/api/login")
      return json(res, 404, { error: "Password sign-in has been removed" });
    if (url === "/auth/logout" && req.method === "POST") {
      if (
        (origin && origin !== (publicOrigin || `http://${host}`)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return json(res, 403, { error: "Invalid origin" });
      auth.logout(req, res);
      return json(res, 200, { ok: true });
    }
    if (url === "/api/users" || url.startsWith("/api/users/")) {
      if (!auth.isAdmin(req))
        return json(res, auth.currentUser(req) ? 403 : 401, {
          error: "Only administrators can manage access",
        });
      if (url === "/api/users" && req.method === "GET")
        return json(res, 200, { users: users.list() });
      if (url.startsWith("/api/users/") && req.method === "PATCH") {
        if (
          (origin && origin !== (publicOrigin || `http://${host}`)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return json(res, 403, { error: "Invalid origin" });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "JSON required" });
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 4096)
              return json(res, 413, { error: "Request too large" });
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          users.setRole(
            auth.currentUser(req)!,
            decodeURIComponent(url.slice("/api/users/".length)),
            body.role as Role,
          );
          return json(res, 200, { users: users.list() });
        } catch (error) {
          return json(res, error instanceof ForbiddenError ? 403 : 400, {
            error: (error as Error).message,
          });
        }
      }
      return json(res, 405, { error: "Method not allowed" });
    }
    if (url === "/api/settings") {
      if (!auth.isAdmin(req))
        return json(res, auth.currentUser(req) ? 403 : 401, {
          error: "Only administrators can change visibility",
        });
      if (req.method === "GET") return json(res, 200, visibility.read());
      if (req.method === "PUT") {
        if (
          (origin && origin !== (publicOrigin || `http://${host}`)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return json(res, 403, { error: "Invalid origin" });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "JSON required" });
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 4096)
              return json(res, 413, { error: "Request too large" });
            chunks.push(Buffer.from(chunk));
          }
          if (!auth.isAdmin(req))
            return json(res, 403, { error: "Access revoked" });
          return json(
            res,
            200,
            visibility.write(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            ),
          );
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      return json(res, 405, { error: "Method not allowed" });
    }
    const visitor = auth.currentUser(req),
      access = visibility.read();
    if (url === "/api/export.json") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return json(res, 405, { error: "Ожидается GET" });
      }
      if (!visitor && !access.publicTree)
        return json(res, 401, { error: "Войдите для экспорта древа" });
      const { family, revision } = archive.read();
      if (parsedUrl.searchParams.get("download") === "1")
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="drevo-family.json"',
        );
      return json(
        res,
        200,
        analysisExport(family, revision, new Date().toISOString()),
      );
    }
    if (
      !visitor &&
      ((url.startsWith("/media/") && !access.publicAlbums) ||
        (["/api/family", "/api/export", "/data/family.json"].includes(url) &&
          !access.publicTree &&
          !access.publicAlbums))
    )
      return json(res, 401, { error: "Sign in to view this archive" });
    if (url === "/api/places/locate") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      if (!visitor && !access.publicTree)
        return json(res, 401, { error: "Войдите для просмотра мест семьи" });
      if (
        req.headers["x-drevo-map"] !== "1" ||
        (origin && origin !== (publicOrigin || `http://${host}`)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return json(res, 403, { error: "Откройте карту в архиве" });
      const query = (parsedUrl.searchParams.get("q") || "").trim();
      if (
        !auth.canEdit(req) &&
        !familyPlaces(archive.read().family.people).some(
          (p) => p.key === placeKey(query),
        )
      )
        return json(res, 403, {
          error: "Можно искать только места из доступного древа",
        });
      try {
        const result = await geocoding.locate(query);
        if (!auth.currentUser(req) && !visibility.read().publicTree)
          return json(res, 401, { error: "Доступ к древу закрыт" });
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (url === "/api/restore/preview" || url === "/api/restore/apply") {
      if (req.method !== "POST")
        return json(res, 405, { error: "Ожидается POST" });
      if (!auth.isAdmin(req))
        return json(res, auth.currentUser(req) ? 403 : 401, {
          error: "Импорт доступен только администратору",
        });
      if (
        (origin && origin !== (publicOrigin || `http://${host}`)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return json(res, 403, { error: "Недопустимый источник запроса" });
      if (req.headers["x-drevo-restore"] !== "1")
        return json(res, 400, { error: "Откройте импорт в админке" });
      const preview = url.endsWith("preview");
      if (preview && restoreUploadBusy)
        return json(res, 429, {
          error: "Уже загружается другой бэкап. Повторите позже.",
        });
      if (preview) restoreUploadBusy = true;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (preview ? RESTORE_LIMIT : 4096))
            return json(res, 413, {
              error: "Файл слишком большой. Максимум 128 МБ.",
            });
          chunks.push(Buffer.from(chunk));
        }
        const actor = auth.currentUser(req);
        if (!actor || !auth.isAdmin(req))
          return json(res, 403, { error: "Доступ администратора отозван" });
        const bytes = Buffer.concat(chunks);
        if (preview)
          return json(res, 200, await restores.preview(bytes, actor));
        const body = JSON.parse(bytes.toString("utf8"));
        if (body.confirm !== true || typeof body.token !== "string")
          return json(res, 400, { error: "Подтвердите замену данных" });
        return json(res, 200, restores.apply(body.token, actor));
      } catch (e) {
        return json(res, e instanceof ConflictError ? 409 : 400, {
          error: (e as Error).message,
        });
      } finally {
        if (preview) restoreUploadBusy = false;
      }
    }
    if (url === "/api/backup/full" && req.method === "GET") {
      if (!auth.isAdmin(req))
        return json(res, visitor ? 403 : 401, {
          error: "Only administrators can download backups",
        });
      await fullBackup(archive.db, dbPath, res);
      return;
    }
    if (url === "/api/backup" && req.method === "GET") {
      if (!auth.isAdmin(req))
        return json(res, auth.currentUser(req) ? 403 : 401, {
          error: "Only administrators can download database backups",
        });
      const bytes = databaseBackup(archive.db);
      res.writeHead(200, {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="drevo-${new Date().toISOString().slice(0, 10)}.sqlite"`,
        "Cache-Control": "no-store",
      });
      res.end(bytes);
      return;
    }
    if (url === "/api/health" && req.method === "GET")
      return json(res, 200, { ok: true, revision: archive.read().revision });
    if (url.startsWith("/media/") && req.method === "GET") {
      const file = media.read(url);
      if (!file) return json(res, 404, { error: "Фото не найдено" });
      res.writeHead(200, {
        "Content-Type": file.type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400",
      });
      res.end(file.bytes);
      return;
    }
    if (!url.startsWith("/api/")) {
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "Метод не поддерживается" });
      const dist = resolve(root, "dist");
      let path = resolve(dist, "." + decodeURIComponent(url));
      if (
        !path.startsWith(dist + "/") &&
        !path.startsWith(dist + "\\") &&
        path !== dist
      )
        return json(res, 403, { error: "Недоступный путь" });
      if (url === "/" || url === "/admin" || url === "/admin/")
        path = resolve(dist, "index.html");
      if (!existsSync(path))
        return json(res, 404, { error: "Страница не найдена" });
      try {
        const bytes = readFileSync(path);
        res.writeHead(200, {
          "Content-Type":
            staticTypes[extname(path)] || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": url.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      } catch {
        return json(res, 404, { error: "Страница не найдена" });
      }
      return;
    }
    if (url === "/api/family" && req.method === "GET")
      return json(res, 200, snapshot(req));
    if (url === "/api/export" && req.method === "GET") {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="drevo-archive.json"',
      );
      return json(res, 200, snapshot(req).family);
    }
    if (!(
      (url === "/api/family" && req.method === "PUT") ||
      (url === "/api/photos" && req.method === "POST")
    ))
      return json(res, 404, { error: "Неизвестный запрос" });
    if (
      (origin && origin !== (publicOrigin || `http://${host}`)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(res, 403, {
        error: "Сохранение разрешено только со страницы архива",
      });
    if (!auth.canEdit(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "You do not have editing access",
      });
    if (
      url === "/api/family" &&
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return json(res, 415, { error: "Ожидается JSON" });
    const revision = Number(req.headers["if-match"]);
    if (
      req.headers["if-match"] === undefined ||
      !Number.isInteger(revision) ||
      revision < 0
    )
      return json(res, 428, { error: "Не указана версия архива" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      const limit = (url === "/api/photos" ? 20 : 8) * 1024 * 1024;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit)
          return json(res, 413, {
            error: `Максимальный размер — ${limit / 1024 / 1024} МБ`,
          });
        chunks.push(Buffer.from(chunk));
      }
      const actor = auth.currentUser(req);
      if (!actor || actor.role === "reader")
        throw new ForbiddenError("Editing access is no longer available");
      if (url === "/api/photos") {
        if (req.headers["x-drevo-upload"] !== "1")
          return json(res, 400, { error: "Некорректная загрузка" });
        const file = media.add(Buffer.concat(chunks));
        try {
          const current = archive.read().family,
            title = decodeURIComponent(
              String(req.headers["x-file-name"] || "Фотография"),
            ).slice(0, 250);
          const metadata = JSON.parse(
            decodeURIComponent(
              String(req.headers["x-photo-metadata"] || "%7B%7D"),
            ),
          );
          if (
            !metadata ||
            typeof metadata !== "object" ||
            Array.isArray(metadata)
          )
            throw new Error("Некорректное описание фотографии");
          const fields: Record<string, string> = {};
          for (const key of ["title", "year", "place", "event", "description"])
            if (metadata[key] !== undefined) {
              if (
                typeof metadata[key] !== "string" ||
                metadata[key].length > 1000
              )
                throw new Error("Слишком длинное описание фотографии");
              if (metadata[key].trim()) fields[key] = metadata[key].trim();
            }
          return json(
            res,
            201,
            archive.write(
              {
                ...current,
                photos: [
                  ...(current.photos || []),
                  { id: file.id, url: file.url, title, ...fields, tags: [] },
                ],
              },
              revision,
              actor,
            ),
          );
        } catch (error) {
          file.undo();
          throw error;
        }
      }
      return json(
        res,
        200,
        archive.write(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          revision,
          actor,
        ),
      );
    } catch (error) {
      return json(
        res,
        error instanceof ConflictError
          ? 409
          : error instanceof ForbiddenError
            ? 403
            : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось сохранить данные",
        },
      );
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: "Ошибка сервера" });
      else res.end();
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  console.log(
    `Древо: http://127.0.0.1:${(server.address() as { port: number }).port}/ · SQLite: ${dbPath}`,
  );
  return {
    server,
    archive,
    close: async () => {
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      restores.close();
      geocoding.close();
      archive.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assertProductionOrigin(
    process.argv.includes("--production"),
    process.env.PUBLIC_ORIGIN,
  );
  const app = await startServer();
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (!closing) {
        closing = true;
        void app.close().then(() => process.exit(0));
      }
    });
}
