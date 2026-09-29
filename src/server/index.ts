import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openArchive } from "./database.ts";
import { removeStarterFamily } from "./demo-cleanup.ts";
import { validateFamily } from "../domain/index.ts";
import { createVkOAuth } from "./vk-oauth.ts";
import { vkAuthSettingsStore } from "./vk-auth-settings.ts";
import { adminVkAuthHttp } from "./admin-vk-auth-http.ts";
import { createYandexOAuth } from "./yandex-oauth.ts";
import { userStore } from "./users.ts";
import { createAuth } from "./auth.ts";
import { settingsStore } from "./settings.ts";
import { mediaStore } from "./media.ts";
import { restoreStore } from "./restore.ts";
import { geocodingStore } from "./geocoding.ts";
import { assertProductionOrigin } from "./runtime-config.ts";
import { imagePreviews } from "./image-previews.ts";
import { archiveHttp } from "./archive-http.ts";
import { gedcomHttp } from "./gedcom-http.ts";
import { productionStaticHttp } from "./production-static-http.ts";
import { backupCoordinator } from "./backup-coordinator.ts";
import { backupManagementHttp } from "./backup-management-http.ts";
import { indexReferencedMediaOriginals } from "./media-originals.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function startServer(
  port = Number(process.env.PORT || 3000),
  databasePath?: string,
  production = process.argv.includes("--production"),
  oauthFetch?: typeof fetch,
  aiFetch?: typeof fetch,
) {
  assertProductionOrigin(
    process.env.NODE_ENV === "production",
    process.env.PUBLIC_ORIGIN,
  );
  const dbPath =
    databasePath ||
    process.env.DATABASE_PATH ||
    resolve(root, "data/drevo.sqlite");
  const archive = await openArchive(
    dbPath,
    validateFamily(
      JSON.parse(
        readFileSync(resolve(root, "public/data/family.json"), "utf8"),
      ),
    ),
  );
  await removeStarterFamily(archive);

  const media = mediaStore(resolve(dirname(dbPath), "uploads"));
  const mediaIndex = await indexReferencedMediaOriginals(
    archive.db,
    (await archive.read()).family,
    media,
  );
  if (mediaIndex.missing)
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "media_references_missing",
        count: mediaIndex.missing,
      }),
    );
  const previewImage = imagePreviews(resolve(dirname(dbPath), "previews"));
  const restores = restoreStore(archive, dbPath);
  const geocoding = geocodingStore(archive.db);
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  const serveStatic = productionStaticHttp(resolve(root, "dist"), production);
  const visibility = await settingsStore(archive.db);
  const users = await userStore(archive.db);
  const auth = await createAuth(users, archive.db, publicOrigin);
  const backups = await backupCoordinator(archive.db, dbPath);
  const manageBackups = backupManagementHttp({
    backups,
    restores,
    auth,
    publicOrigin,
  });
  const handleArchive = await archiveHttp({
    geocoding,
    restores,
    archive,
    auth,
    media,
    previewImage,
    visibility,
    publicOrigin,
    aiFetch,
    uploadsDirectory: resolve(dirname(dbPath), "uploads"),
    serveStatic,
  });
  const gedcom = gedcomHttp(archive, auth, dbPath, publicOrigin);
  const yandex = createYandexOAuth({
    origin: publicOrigin,
    clientId: process.env.YANDEX_CLIENT_ID,
    clientSecret: process.env.YANDEX_CLIENT_SECRET,
    issueSession: auth.issueSession,
    fetcher: oauthFetch,
    db: archive.db,
  });
  const vkSettings = vkAuthSettingsStore(
    archive.db,
    publicOrigin,
    process.env.VK_CLIENT_ID,
  );
  const manageVkAuth = adminVkAuthHttp(auth, vkSettings, publicOrigin);
  const vk = createVkOAuth({
    origin: publicOrigin,
    clientId: process.env.VK_CLIENT_ID,
    configuration: async () => {
      const settings = await vkSettings.read();
      return { enabled: settings.available, clientId: settings.clientId };
    },
    issueSession: auth.issueSession,
    fetcher: oauthFetch,
    db: archive.db,
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
    const host = req.headers.host || "";
    if (
      !/^(127\.0\.0\.1|localhost):\d+$/.test(host) &&
      !(publicOrigin && host === new URL(publicOrigin).host)
    )
      return json(res, 403, { error: "Неизвестный адрес архива" });

    const parsedUrl = new URL(req.url || "/", `http://${host}`),
      path = parsedUrl.pathname;
    if (path.startsWith("/api/")) await auth.refreshSession(req, res);
    if (await manageVkAuth(req, res, parsedUrl)) return;
    if (await manageBackups(req, res, parsedUrl)) return;
    if (await handleArchive(req, res, parsedUrl)) return;
    if (await gedcom.handle(req, res, parsedUrl)) return;
    if (await yandex.handle(req, res, parsedUrl)) return;
    if (await vk.handle(req, res, parsedUrl)) return;

    if (path === "/api/session" && req.method === "GET") {
      const sessionUser = await auth.currentUser(req);
      return json(res, 200, {
        canEdit: await auth.canEdit(req),
        local: auth.local,
        yandex: yandex.enabled,
        vk: await vk.isEnabled(),
        user: sessionUser
          ? {
              ...sessionUser,
              platformAdmin: await auth.isPlatformAdmin(req),
            }
          : null,
      });
    }

    if (!path.startsWith("/api/")) {
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      return json(res, 404, { error: "Страница не найдена" });
    }
    return json(res, 404, { error: "Неизвестный запрос" });
  }

  let activeRequests = 0;
  const server = createServer((req, res) => {
    const requestId = randomUUID(),
      started = Date.now();
    res.setHeader("X-Request-ID", requestId);
    activeRequests++;
    void handle(req, res)
      .catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "request_failed",
            requestId,
            method: req.method,
            route: (req.url || "").startsWith("/s/")
              ? "/s/[redacted]"
              : (req.url || "").startsWith("/api/shared/")
                ? "/api/shared/[redacted]"
                : (req.url || "").split("?")[0],
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!res.headersSent) json(res, 500, { error: "Ошибка сервера" });
        else res.end();
      })
      .finally(() => {
        activeRequests--;
        const path = (req.url || "").split("?")[0];
        if (production)
          console.log(
            JSON.stringify({
              level: "info",
              event: "request",
              requestId,
              method: req.method,
              route: /^\/(?:s|api\/shared)\//.test(path)
                ? path.startsWith("/s/")
                  ? "/s/[redacted]"
                  : "/api/shared/[redacted]"
                : path,
              status: res.statusCode,
              durationMs: Date.now() - started,
            }),
          );
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
    `Древо: http://127.0.0.1:${(server.address() as { port: number }).port}/ · ${archive.db.kind === "postgres" ? "PostgreSQL: " + archive.db.archiveId : "SQLite: " + dbPath}`,
  );
  return {
    server,
    archive,
    close: async () => {
      await vite?.close();
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeIdleConnections();
      await handleArchive.close();
      const deadline = Date.now() + 15000;
      while (activeRequests > 0 && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 25));
      if (activeRequests > 0) server.closeAllConnections();
      await closed;
      await backups.close();
      await restores.close();
      await gedcom.close();
      geocoding.close();
      await archive.close();
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
