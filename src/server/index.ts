import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { openArchive, ConflictError } from "./database.ts";
import { validateFamily } from "../domain/index.ts";
import { createYandexOAuth } from "./yandex-oauth.ts";
import { createAuth } from "./auth.ts";
import { databaseBackup } from "./backup.ts";
import { mediaStore } from "./media.ts";

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
) {
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
  const media = mediaStore(resolve(dirname(dbPath), "uploads"));
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  const auth = createAuth(publicOrigin);
  const yandex = createYandexOAuth({
    origin: publicOrigin,
    clientId: process.env.YANDEX_CLIENT_ID,
    clientSecret: process.env.YANDEX_CLIENT_SECRET,
    allowedIds: (process.env.YANDEX_ALLOWED_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    issueSession: auth.issueSession,
  });
  const snapshot = (req: IncomingMessage) => ({
    ...archive.read(),
    canEdit: auth.canEdit(req),
    local: auth.local,
  });
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
        passwordLogin: auth.passwordLogin,
      });
    if (
      (url === "/api/login" ||
        url === "/api/logout" ||
        url === "/auth/logout") &&
      req.method === "POST"
    ) {
      if (
        (origin && origin !== (publicOrigin || `http://${host}`)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return json(res, 403, { error: "Invalid origin" });
      if (url === "/api/logout" || url === "/auth/logout") {
        auth.logout(req, res);
        return json(res, 200, { ok: true });
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return json(res, 413, { error: "Request too large" });
        chunks.push(Buffer.from(chunk));
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          typeof body.username !== "string" ||
          typeof body.password !== "string"
        )
          throw new Error();
        const ok = await auth.login(req, res, body.username, body.password);
        return json(res, ok ? 200 : 401, {
          ok,
          error: ok ? undefined : "Invalid credentials or too many attempts",
        });
      } catch {
        return json(res, 400, { error: "Invalid login request" });
      }
    }
    if (
      auth.privateArchive &&
      url !== "/api/health" &&
      !auth.canEdit(req) &&
      (url.startsWith("/media/") ||
        url.startsWith("/api/") ||
        url === "/data/family.json")
    )
      return json(res, 401, { error: "Sign in to view this archive" });
    if (url === "/api/backup" && req.method === "GET") {
      if (!auth.canEdit(req))
        return json(res, 401, { error: "Sign in to download a backup" });
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
      if (url === "/") path = resolve(dist, "index.html");
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
      return json(res, 200, archive.read().family);
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
      return json(res, 401, { error: "Sign in to edit the archive" });
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
      if (url === "/api/photos") {
        if (req.headers["x-drevo-upload"] !== "1")
          return json(res, 400, { error: "Некорректная загрузка" });
        const file = media.add(Buffer.concat(chunks));
        try {
          const current = archive.read().family,
            title = decodeURIComponent(
              String(req.headers["x-file-name"] || "Фотография"),
            ).slice(0, 250);
          return json(
            res,
            201,
            archive.write(
              {
                ...current,
                photos: [
                  ...(current.photos || []),
                  { id: file.id, url: file.url, title, tags: [] },
                ],
              },
              revision,
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
        ),
      );
    } catch (error) {
      return json(res, error instanceof ConflictError ? 409 : 400, {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось сохранить данные",
      });
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
      archive.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
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
