import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openArchive } from "./database.ts";
import { removeStarterFamily } from "./demo-cleanup.ts";
import { validateFamily } from "../domain/index.ts";
import { createYandexOAuth } from "./yandex-oauth.ts";
import { userStore } from "./users.ts";
import { createAuth } from "./auth.ts";
import { settingsStore } from "./settings.ts";
import { mediaStore } from "./media.ts";
import { restoreStore } from "./restore.ts";
import { geocodingStore } from "./geocoding.ts";
import { assertProductionOrigin } from "./runtime-config.ts";
import { imagePreviews } from "./image-previews.ts";
import { sharingHttp } from "./sharing-http.ts";
import { gedcomHttp } from "./gedcom-http.ts";
import { productionStaticHttp } from "./production-static-http.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  const previewImage = imagePreviews(resolve(dirname(dbPath), "previews"));
  const restores = restoreStore(archive, dbPath);
  const geocoding = geocodingStore(archive.db);
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  const visibility = settingsStore(archive.db);
  const users = userStore(archive.db);
  const auth = createAuth(users, archive.db, publicOrigin);
  const sharing = sharingHttp({
    archive,
    auth,
    media,
    previewImage,
    visibility,
    publicOrigin,
  });
  const gedcom = gedcomHttp(archive, auth, dbPath, publicOrigin);
  const yandex = createYandexOAuth({
    origin: publicOrigin,
    clientId: process.env.YANDEX_CLIENT_ID,
    clientSecret: process.env.YANDEX_CLIENT_SECRET,
    issueSession: auth.issueSession,
    fetcher: oauthFetch,
  });
  // production=true используется и тестами/встраиваемыми запусками без NODE_ENV.
  // В штатном production запрос уже заберёт ранний static handler в sharingHttp.
  const productionStatic = production
    ? productionStaticHttp(resolve(root, "dist"), true)
    : null;
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
    if (path.startsWith("/api/")) auth.refreshSession(req, res);
    if (await sharing(req, res, parsedUrl)) return;
    if (await gedcom.handle(req, res, parsedUrl)) return;
    if (await yandex.handle(req, res, parsedUrl)) return;

    if (path === "/api/session" && req.method === "GET")
      return json(res, 200, {
        canEdit: auth.canEdit(req),
        local: auth.local,
        yandex: yandex.enabled,
        user: auth.currentUser(req),
      });

    if (productionStatic && (await productionStatic(req, res, parsedUrl))) return;
    if (!path.startsWith("/api/")) {
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      return json(res, 404, { error: "Страница не найдена" });
    }
    return json(res, 404, { error: "Неизвестный запрос" });
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
      await new Promise<void>((done) => server.close(() => done()));
      restores.close();
      gedcom.close();
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
