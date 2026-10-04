import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname, basename } from "node:path";
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
import { emailAuthHttp } from "./email-auth-http.ts";
import { settingsStore } from "./settings.ts";
import { mediaStore } from "./media.ts";
import { restoreStore } from "./restore.ts";
import { geocodingStore } from "./geocoding.ts";
import { assertProductionOrigin } from "./runtime-config.ts";
import { imagePreviews } from "./image-previews.ts";
import { archiveHttp } from "./archive-http.ts";
import { gedcomHttp } from "./gedcom-http.ts";
import { portableExportHttp } from "./portable-http.ts";
import { portableImportHttp } from "./portable-import-http.ts";
import { productionStaticHttp } from "./production-static-http.ts";
import { backupCoordinator } from "./backup-coordinator.ts";
import { backupManagementHttp } from "./backup-management-http.ts";
import { indexReferencedMediaOriginals } from "./media-originals.ts";
import { configuredDatabaseBackend } from "./store-database.ts";
import { accountArchiveDirectory } from "./account-archives.ts";
import { accountArchivesHttp } from "./account-archives-http.ts";
import { accountDataExportHttp } from "./account-data-export-http.ts";
import { accountAttachmentExportHttp } from "./account-attachment-export-http.ts";
import { accountSelfDeletionHttp } from "./account-self-deletion-http.ts";
import { archiveOwnerTransferHttp } from "./archive-owner-transfer-http.ts";
import { archiveDeletionHttp } from "./archive-deletion-http.ts";
import { cleanupDeletedArchiveDirectories } from "./archive-deletion-files.ts";
import { sweepPlatformAiOrphans } from "./platform-ai-orphan-sweep.ts";
import { aiProviderCleanup } from "./ai-provider-cleanup.ts";
import { discoveryPeopleHttp } from "./discovery-people-http.ts";
import { accountInvitationsHttp } from "./account-invitations-http.ts";
import { archiveRoutePool } from "./archive-route-pool.ts";
import { publicShareAccess } from "./public-share-access.ts";
import { safeRequestRoute } from "./safe-request-route.ts";
import { sessionHttp } from "./session-http.ts";
import { platformRolesHttp } from "./platform-roles-http.ts";
import { sourceCatalogHttp } from "./source-catalog-http.ts";
import { initializePlatformConfiguration } from "./platform-configuration.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type StartedServer = {
  server: ReturnType<typeof createServer>;
  archive: Awaited<ReturnType<typeof openArchive>>;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    path?: string,
  ) => Promise<void>;
  close: () => Promise<void>;
};

export async function startServer(
  port = Number(process.env.PORT || 3000),
  databasePath?: string,
  production = process.argv.includes("--production"),
  oauthFetch?: typeof fetch,
  aiFetch?: typeof fetch,
  archiveId?: string,
): Promise<StartedServer> {
  assertProductionOrigin(
    process.env.NODE_ENV === "production",
    process.env.PUBLIC_ORIGIN,
  );
  const selectedPath =
    databasePath ||
    process.env.DATABASE_PATH ||
    resolve(root, "data/drevo.sqlite");
  const configuredPath = selectedPath === ":memory:" ? selectedPath : resolve(selectedPath);
  if (archiveId && !/^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/.test(archiveId))
    throw new Error("Некорректный archive_id");
  if (archiveId && configuredDatabaseBackend(configuredPath) !== "postgres")
    throw new Error("Явный archive_id поддерживается только PostgreSQL");
  // Preserve the existing archive's paths; another archive gets its own media,
  // previews, import staging and local backup directory on this host.
  const dbPath =
    archiveId && archiveId !== process.env.ARCHIVE_ID
      ? resolve(
          dirname(configuredPath),
          "archives",
          archiveId,
          basename(configuredPath),
        )
      : configuredPath;
  const releases: Array<() => Promise<void>> = [];
  const own = (release: () => void | Promise<void>) => {
    let released: Promise<void> | undefined;
    const close = () => (released ??= Promise.resolve().then(release));
    releases.push(close);
    return close;
  };
  const releaseResources = async () => {
    const errors: unknown[] = [];
    for (const release of [...releases].reverse()) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Не удалось закрыть ресурсы сервера");
  };
  try {
    const archive = await openArchive(
      dbPath,
      validateFamily(
        JSON.parse(
          readFileSync(resolve(root, "public/data/family.json"), "utf8"),
        ),
      ),
      archiveId,
    );
    own(() => archive.close());
    if (!archiveId)
      await initializePlatformConfiguration(archive.db, process.env.ARCHIVE_ID || "");
    const providerCleanup = archive.db.kind === "postgres"
      ? await aiProviderCleanup(archive.db, configuredPath, aiFetch)
      : undefined;
    let providerCleanupRun: Promise<void> | null = null;
    const sweepProviderConversations = !archiveId && providerCleanup
      ? () => {
          if (providerCleanupRun) return;
          providerCleanupRun = providerCleanup.process(2)
            .then(() => undefined)
            .catch(() => console.warn(JSON.stringify({ event: "ai.provider_cleanup_failed" })))
            .finally(() => { providerCleanupRun = null; });
        }
      : null;
    sweepProviderConversations?.();
    const providerCleanupTimer = sweepProviderConversations
      ? setInterval(sweepProviderConversations, 60_000) : null;
    providerCleanupTimer?.unref();
    own(async () => {
      if (providerCleanupTimer) clearInterval(providerCleanupTimer);
      await providerCleanupRun;
    });
    const cleanupDeletedArchives =
      !archiveId && archive.db.kind === "postgres"
        ? () =>
            cleanupDeletedArchiveDirectories(archive.db, configuredPath).catch(
              (error) => console.error("archive_file_cleanup_failed", error),
            )
        : null;
    await cleanupDeletedArchives?.();
    const archiveCleanupTimer = cleanupDeletedArchives
      ? setInterval(() => void cleanupDeletedArchives(), 60 * 60_000)
      : null;
    archiveCleanupTimer?.unref();
    own(() => {
      if (archiveCleanupTimer) clearInterval(archiveCleanupTimer);
    });
    let aiSweepPromise: Promise<void> | null = null;
    const sweepInactiveAiFiles =
      !archiveId && archive.db.kind === "postgres"
        ? () => {
            if (aiSweepPromise) return;
            aiSweepPromise = sweepPlatformAiOrphans(archive.db, configuredPath)
              .then(() => undefined)
              .catch((error) =>
                console.error("ai_orphan_sweep_failed", "platform", error),
              )
              .finally(() => {
                aiSweepPromise = null;
              });
          }
        : null;
    // Filesystem pruning is intentionally outside request handling and startup's
    // critical path. A failed pass is retried on the next hourly run.
    sweepInactiveAiFiles?.();
    const aiSweepTimer = sweepInactiveAiFiles
      ? setInterval(sweepInactiveAiFiles, 60 * 60_000)
      : null;
    aiSweepTimer?.unref();
    const stopSweeps = own(async () => {
      if (archiveCleanupTimer) clearInterval(archiveCleanupTimer);
      if (aiSweepTimer) clearInterval(aiSweepTimer);
      await aiSweepPromise;
    });
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
    own(() => restores.close());
    const geocoding = geocodingStore(archive.db);
    own(() => geocoding.close());
    const publicOrigin = process.env.PUBLIC_ORIGIN;
    const serveStatic = productionStaticHttp(resolve(root, "dist"), production);
    const visibility = await settingsStore(archive.db);
    const users = await userStore(archive.db);
    const auth = await createAuth(users, archive.db, publicOrigin);
    const managePlatformRoles = platformRolesHttp(archive.db, auth, publicOrigin);
    const emailAuth = !archiveId
      ? emailAuthHttp(archive.db, auth, publicOrigin)
      : null;
    const listAccountArchives = accountArchivesHttp(
      auth,
      accountArchiveDirectory(archive.db),
      archive.db,
      publicOrigin,
      !archiveId,
    );
    const exportAccountData = accountDataExportHttp(archive.db, auth);
    const exportAccountAttachments = accountAttachmentExportHttp(
      archive.db,
      auth,
      (targetArchiveId) =>
        resolve(
          dirname(configuredPath),
          ...(targetArchiveId === process.env.ARCHIVE_ID
            ? []
            : ["archives", targetArchiveId]),
          "uploads",
        ),
    );
    const deleteAccount = accountSelfDeletionHttp(
      archive.db,
      auth,
      !archiveId,
      publicOrigin,
    );
    const transferArchiveOwner = archiveOwnerTransferHttp(
      archive.db,
      auth,
      publicOrigin,
    );
    const deleteArchive = archiveDeletionHttp(
      archive.db,
      auth,
      configuredPath,
      archiveId && archiveId !== process.env.ARCHIVE_ID ? archiveId : undefined,
      publicOrigin,
    );
    const searchPublishedPeople = discoveryPeopleHttp(archive.db, auth);
    const manageAccountInvitations = !archiveId
      ? accountInvitationsHttp(archive.db, auth, publicOrigin)
      : null;
    const directory = accountArchiveDirectory(archive.db);
    const canOpenShared = publicShareAccess(archive.db);
    const routedArchives =
      archive.db.kind === "postgres" && !archiveId
        ? archiveRoutePool(
            async (req, id, path) => {
              const shareToken =
                /^\/api\/shared\/([A-Za-z0-9_-]{43})(?:\/portrait\/[^/]+)?$/.exec(
                  path,
                )?.[1];
              if (shareToken) return await canOpenShared(id, shareToken);
              const accountId = await auth.accountId(req);
              if (!accountId) return false;
              return await directory.contains(accountId, id);
            },
            async (id) =>
              await startServer(
                0,
                configuredPath,
                production,
                oauthFetch,
                aiFetch,
                id,
              ),
          )
        : null;
    own(async () => {
      await routedArchives?.close();
    });
    const backups = await backupCoordinator(archive.db, dbPath);
    own(() => backups.close());
    const manageBackups = backupManagementHttp({
      backups,
      restores,
      auth,
      db: archive.db,
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
      selectedArchiveId: archiveId,
      providerCleanup,
      serveStatic,
    });
    const stopRequests = own(() => handleArchive.close());
    const gedcom = gedcomHttp(archive, auth, dbPath, publicOrigin);
    own(() => gedcom.close());
    const portableExport = portableExportHttp(
      archive,
      auth,
      resolve(dirname(dbPath), "uploads"),
    );
    const portableImport = portableImportHttp(
      archive,
      auth,
      dbPath,
      publicOrigin,
    );
    own(() => portableImport.close());
    const handleSources = sourceCatalogHttp(archive, auth, publicOrigin);
    const yandex = createYandexOAuth({
      origin: publicOrigin,
      clientId: process.env.YANDEX_CLIENT_ID,
      clientSecret: process.env.YANDEX_CLIENT_SECRET,
      issueSession: (req, res, profile) =>
        auth.issueOAuthSession(req, res, "yandex", profile),
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
      issueSession: (req, res, profile) =>
        auth.issueOAuthSession(req, res, "vk", profile),
      fetcher: oauthFetch,
      db: archive.db,
    });
    const showSession = sessionHttp(auth, archive.db, {
      yandex: yandex.enabled,
      vk: () => vk.isEnabled(),
      email: emailAuth?.enabled === true,
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
    const stopVite = own(async () => {
      await vite?.close();
    });

    const json = (res: ServerResponse, status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };

    async function handle(
      req: IncomingMessage,
      res: ServerResponse,
      overridePath?: string,
    ) {
      const host = req.headers.host || "";
      if (
        !/^(127\.0\.0\.1|localhost):\d+$/.test(host) &&
        !(publicOrigin && host === new URL(publicOrigin).host)
      )
        return json(res, 403, { error: "Неизвестный адрес архива" });

      const parsedUrl = new URL(
          overridePath || req.url || "/",
          `http://${host}`,
        ),
        path = parsedUrl.pathname;
      if (routedArchives && (await routedArchives.route(req, res, parsedUrl)))
        return;
      if (path.startsWith("/api/")) await auth.refreshSession(req, res);
      if (emailAuth && (await emailAuth.handle(req, res, parsedUrl))) return;
      if (await managePlatformRoles(req, res, parsedUrl)) return;
      if (await listAccountArchives(req, res, parsedUrl)) return;
      if (await exportAccountData(req, res, parsedUrl)) return;
      if (await exportAccountAttachments(req, res, parsedUrl)) return;
      if (await deleteAccount(req, res, parsedUrl)) return;
      if (await searchPublishedPeople(req, res, parsedUrl)) return;
      if (
        manageAccountInvitations &&
        (await manageAccountInvitations(req, res, parsedUrl))
      )
        return;
      if (await manageVkAuth(req, res, parsedUrl)) return;
      if (await manageBackups(req, res, parsedUrl)) return;
      if (await handleArchive(req, res, parsedUrl)) return;
      if (await handleSources(req, res, parsedUrl)) return;
      if (await transferArchiveOwner(req, res, parsedUrl)) return;
      if (await deleteArchive(req, res, parsedUrl)) return;
      if (await gedcom.handle(req, res, parsedUrl)) return;
      if (await portableExport(req, res, parsedUrl)) return;
      if (await portableImport.handle(req, res, parsedUrl)) return;
      if (await yandex.handle(req, res, parsedUrl)) return;
      if (await vk.handle(req, res, parsedUrl)) return;

      if (await showSession(req, res, parsedUrl)) return;

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
              route: safeRequestRoute(req.url || ""),
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          if (!res.headersSent) json(res, 500, { error: "Ошибка сервера" });
          else res.end();
        })
        .finally(() => {
          activeRequests--;
          if (production)
            console.log(
              JSON.stringify({
                level: "info",
                event: "request",
                requestId,
                method: req.method,
                route: safeRequestRoute(req.url || ""),
                status: res.statusCode,
                durationMs: Date.now() - started,
              }),
            );
        });
    });
    own(async () => {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((done) => server.close(() => done()));
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
    let closing: Promise<void> | undefined;
    return {
      server,
      archive,
      handle,
      close: () =>
        (closing ??= (async () => {
          try {
            await stopSweeps();
            await stopVite();
            const closed = new Promise<void>((done) =>
              server.close(() => done()),
            );
            server.closeIdleConnections();
            await stopRequests();
            const deadline = Date.now() + 15000;
            while (activeRequests > 0 && Date.now() < deadline)
              await new Promise((done) => setTimeout(done, 25));
            if (activeRequests > 0) server.closeAllConnections();
            await closed;
            // Responses can finish after the first shutdown pass, while their
            // handlers are draining. Flush those audit writes before the DB.
            await handleArchive.close();
          } finally {
            await releaseResources();
          }
        })()),
    };
  } catch (error) {
    await releaseResources().catch((cleanupError) =>
      console.error("server_startup_cleanup_failed", cleanupError),
    );
    throw error;
  }
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
