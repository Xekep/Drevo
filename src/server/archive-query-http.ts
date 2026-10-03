import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { settingsStore } from "./settings.ts";
import type { treePreferencesStore } from "./tree-preferences.ts";
import type { researchCatalogStore } from "./research-catalog.ts";
import type { ResearchDirectoryCategory } from "../shared/research-catalog.ts";
import { peopleSearchStore } from "./people-search.ts";
import { analysisExport } from "../domain/analysis-export.ts";
import {
  archiveOverview,
  personDetails,
  archivePageSize,
} from "../domain/archive-projection.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { DEFAULT_TREE_PREFERENCES } from "../domain/tree-preferences.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { AccountSessionBusy, AccountSessionExpired, assertActiveAccountSession } from "./account-session-guard.ts";
import { accountAiAccess } from "./account-ai-access.ts";

export function archiveQueryHttp({
  archive,
  auth,
  visibility,
  treePreferences,
  researchCatalog,
  beforeDelivery,
  beforeLockedDelivery,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  treePreferences: ReturnType<typeof treePreferencesStore>;
  researchCatalog: ReturnType<typeof researchCatalogStore>;
  beforeDelivery?: () => Promise<void>;
  beforeLockedDelivery?: () => Promise<void>;
}) {
  const searchPeople = peopleSearchStore(archive.db);
  const publicSearchLimiter = createSharedRequestLimiter(archive.db, "public-people-search", {
    windowMs: 60_000,
    limit: 60,
  });
  const revisionQuery = archive.db.prepare(
    "SELECT revision FROM archive WHERE id=1",
    "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id',true)",
  );
  const scopedSnapshot = async (
    user: NonNullable<Awaited<ReturnType<typeof auth.currentUser>>>,
  ) => {
    const data = await archive.read();
    return { ...data, family: projectFamilyForUser(data.family, user) };
  };
  const exposedUser = async (
    req: IncomingMessage,
    user: Awaited<ReturnType<typeof auth.currentUser>>,
  ) => user ? {
    ...user,
    platformAdmin: await auth.isPlatformAdmin(req),
    aiAvailable: user.approved === true && user.role === "admin"
      ? await accountAiAccess(archive.db, user.id, auth.local)
      : false,
  } : null;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const snapshot = async (
    req: IncomingMessage,
    user: Awaited<ReturnType<typeof auth.currentUser>>,
    settings: Awaited<ReturnType<typeof visibility.read>>,
  ) => {
    const personalPreferences = user ? await treePreferences.read(user.id) : null,
      readTree = user?.approved === true || settings.publicTree,
      readPhotos = user?.approved === true || settings.publicAlbums;
    const data = isScopedUser(user)
      ? await scopedSnapshot(user)
      : await archive.read();
    if (!readTree) {
      data.family.people = [];
      data.family.links = [];
      data.family.photos = data.family.photos?.map((photo) => ({
        ...photo,
        tags: [],
      }));
    }
    if (!readPhotos) {
      data.family.photos = [];
      data.family.people = data.family.people.map((person) => ({
        ...person,
        photo: undefined,
      }));
    }
    return {
      ...data,
      canEdit: await auth.canEdit(req),
      local: auth.local,
      user: await exposedUser(req, user),
      readTree,
      readPhotos,
      reverseTimeline:
        personalPreferences?.reverseTimeline ??
        DEFAULT_TREE_PREFERENCES.reverseTimeline,
      treePreferences: personalPreferences,
    };
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (
      path !== "/api/people/search" &&
      path !== "/api/research-resources" &&
      path !== "/api/export.json" &&
      path !== "/api/family" &&
      path !== "/api/export"
    )
      return false;

    const visitor = await auth.currentUser(req),
      access = await visibility.read();
    const memberCanRead = visitor?.approved === true;
    const scoped = isScopedUser(visitor);
    // An unscoped export must not release people removed after its snapshot.
    const stableRevision = scoped || path === "/api/export" || path === "/api/export.json";
    const startRevision = stableRevision
      ? Number((await revisionQuery.get())?.revision)
      : null;
    const accessStillCurrent = async () => {
      const current = await auth.currentUser(req);
      const settings = await visibility.read();
      const revisionCurrent = !stableRevision ||
        (Number.isSafeInteger(startRevision) &&
          Number((await revisionQuery.get())?.revision) === startRevision);
      return revisionCurrent &&
        current?.id === visitor?.id &&
        current?.role === visitor?.role &&
        current?.approved === visitor?.approved &&
        current?.personId === visitor?.personId &&
        current?.treeAccess === visitor?.treeAccess &&
        settings.publicTree === access.publicTree &&
        settings.publicAlbums === access.publicAlbums;
    };
    const canDeliver = async () => {
      const valid = await archive.db.transaction(async () => {
        return await accessStillCurrent();
      }, true);
      await beforeDelivery?.();
      return valid;
    };
    const changed = () => json(res, 409, {
      error: "Архив или доступ к нему изменились. Повторите запрос.",
    });
    const deliverArchiveJson = async (value: unknown, contentDisposition?: string) => {
      if (archive.db.kind !== "postgres") {
        if (!await canDeliver()) return changed();
        if (contentDisposition) res.setHeader("Content-Disposition", contentDisposition);
        return json(res, 200, value);
      }
      // A large projection is serialized before taking the archive lock.
      const body = JSON.stringify(value);
      await beforeDelivery?.();
      const valid = await archive.db.transaction(async () => {
        // Archive writes and visibility changes lock this row first. A session
        // deletion may lock its session first, so do not wait for that row.
        if (visitor && !auth.local) {
          const session = await auth.accountSession(req);
          if (!session || session.accountId !== visitor.id) return false;
          await assertActiveAccountSession(archive.db, visitor.id, session.tokenHash);
          const archiveId = archive.db.archiveId;
          if (!archiveId) return false;
          const membership = await archive.db.prepare("", `SELECT 1 FROM archive_memberships
            WHERE archive_id=? AND user_id=? FOR SHARE`).get(archiveId, visitor.id);
          if (!membership) return false;
        }
        if (!await accessStillCurrent()) return false;
        await beforeLockedDelivery?.();
        if (res.destroyed) return true;
        const delivered = finished(res, { cleanup: true });
        const timeout = setTimeout(() => res.destroy(), 5_000);
        timeout.unref();
        try {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...(contentDisposition ? { "Content-Disposition": contentDisposition } : {}),
          });
          res.end(body);
          await delivered;
        } catch (error) {
          const disconnected = res.destroyed;
          res.destroy();
          await delivered.catch(() => {});
          if (!disconnected && !res.headersSent) throw error;
        } finally { clearTimeout(timeout); }
        return true;
      }).catch((error) => {
        if (error instanceof AccountSessionExpired || error instanceof AccountSessionBusy ||
            (error as { code?: string }).code === "55P03") return false;
        throw error;
      });
      return valid || res.headersSent || res.destroyed ? true : changed();
    };

    if (path === "/api/research-resources") {
      if (!memberCanRead && !access.publicTree)
        return json(res, 401, { error: "Войдите, чтобы открыть справочник" });
      if (req.method !== "GET")
        return json(res, 405, {
          error: "Справочник доступен только для чтения",
        });
      const categories: ResearchDirectoryCategory[] = (
        await researchCatalog.list()
      ).map(({ id, name, resources }) => ({
        id,
        name,
        resources: resources.map(
          ({ id, categoryId, name, url, description }) => ({
            id,
            categoryId,
            name,
            url,
            description,
          }),
        ),
      }));
      return deliverArchiveJson({ categories });
    }

    if (path === "/api/family") {
      if (req.method !== "GET") return false;
      if (
        !memberCanRead &&
        !access.publicTree &&
        !access.publicAlbums
      )
        return json(res, 401, { error: "Sign in to view this archive" });
      const projection = url.searchParams.get("projection");
      if (projection === "page") {
        const readTree = memberCanRead || access.publicTree,
          readPhotos = memberCanRead || access.publicAlbums;
        const collection = url.searchParams.get("collection"),
          offset = Number(url.searchParams.get("offset"));
        if (
          !["people", "photos"].includes(collection || "") ||
          !Number.isInteger(offset) ||
          offset < 0
        )
          return json(res, 400, { error: "Некорректная страница" });
        const page = await archive.db.transaction(async () => {
          const meta = await archive.meta();
          const pageToken = `${meta.revision}:${Number(readTree)}:${Number(readPhotos)}:${visitor?.id || "guest"}:${visitor?.personId || ""}:${visitor?.treeAccess || "all"}`;
          if (url.searchParams.get("token") !== pageToken) return null;
          const scoped = isScopedUser(visitor)
            ? (await scopedSnapshot(visitor)).family
            : null;
          if (collection === "people")
            return {
              pageToken,
              items: readTree
                ? (scoped
                    ? scoped.people.slice(offset, offset + archivePageSize)
                    : await archive.peoplePage(offset, archivePageSize)
                  ).map(personDetails)
                : [],
              total: readTree ? (scoped?.people.length ?? meta.people) : 0,
            };
          return {
            pageToken,
            items: readPhotos
              ? (scoped
                  ? (scoped.photos || []).slice(
                      offset,
                      offset + archivePageSize,
                    )
                  : await archive.photoPage(offset, archivePageSize)
                ).map((photo) => (readTree ? photo : { ...photo, tags: [] }))
              : [],
            total: readPhotos ? (scoped?.photos?.length ?? meta.photos) : 0,
          };
        }, true);
        if (!page)
          return json(res, 409, {
            error: "Архив или доступ к нему изменились. Обновите данные.",
          });
        return deliverArchiveJson(page);
      }
      if (projection === "overview") {
        const readTree = memberCanRead || access.publicTree,
          readPhotos = memberCanRead || access.publicAlbums;
        let data: Awaited<ReturnType<typeof archive.overview>>;
        if (readTree) {
          if (isScopedUser(visitor)) {
            const { family: scoped, revision } = await scopedSnapshot(visitor);
            data = {
              family: archiveOverview(
                readPhotos
                  ? scoped
                  : {
                      ...scoped,
                      people: scoped.people.map((person) => ({
                        ...person,
                        photo: undefined,
                      })),
                    },
              ),
              revision,
              totals: {
                people: scoped.people.length,
                photos: scoped.photos?.length || 0,
              },
            };
          } else data = await archive.overview(readPhotos);
        } else {
          const meta = await archive.meta();
          data = {
            family: {
              title: meta.title,
              description: meta.description,
              demo: meta.demo,
              people: [],
              links: [],
              photos: [],
            },
            revision: meta.revision,
            totals: { people: meta.people, photos: meta.photos },
          };
        }
        const personalPreferences = visitor
          ? await treePreferences.read(visitor.id)
          : null;
        const pageToken = `${data.revision}:${Number(readTree)}:${Number(readPhotos)}:${visitor?.id || "guest"}:${visitor?.personId || ""}:${visitor?.treeAccess || "all"}`;
        const canEdit = await auth.canEdit(req);
        return deliverArchiveJson({
          family: data.family,
          revision: data.revision,
          canEdit,
          local: auth.local,
          user: await exposedUser(req, visitor),
          readTree,
          readPhotos,
          reverseTimeline:
            personalPreferences?.reverseTimeline ??
            DEFAULT_TREE_PREFERENCES.reverseTimeline,
          treePreferences: personalPreferences,
          partial: true,
          pageToken,
          totals: {
            people: readTree ? data.totals.people : 0,
            photos: readPhotos ? data.totals.photos : 0,
          },
        });
      }
      const prepared = await snapshot(req, visitor, access);
      return deliverArchiveJson(prepared);
    }

    if (path === "/api/export") {
      if (req.method !== "GET") return false;
      if (
        !memberCanRead &&
        !access.publicTree &&
        !access.publicAlbums
      )
        return json(res, 401, { error: "Sign in to view this archive" });
      const prepared = await snapshot(req, visitor, access);
      return deliverArchiveJson(prepared.family,
        'attachment; filename="drevo-archive.json"');
    }

    if (path === "/api/people/search") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      if (!memberCanRead && !access.publicTree)
        return json(res, 401, { error: "Войдите для поиска людей" });
      if (
        !memberCanRead &&
        !(await publicSearchLimiter.allow(
          requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress),
        ))
      ) {
        res.setHeader("Retry-After", "60");
        return json(res, 429, {
          error: "Слишком много запросов поиска. Попробуйте через минуту.",
        });
      }
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length > 100)
        return json(res, 400, { error: "Слишком длинный поисковый запрос" });
      const visible = isScopedUser(visitor)
        ? new Set(
            (await scopedSnapshot(visitor)).family.people.map(
              (person) => person.id,
            ),
          )
        : undefined;
      const matches = await searchPeople(query, visible);
      return deliverArchiveJson(matches);
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Ожидается GET" });
    }
    if (!memberCanRead && !access.publicTree)
      return json(res, 401, { error: "Войдите для экспорта древа" });
    const { family, revision } = isScopedUser(visitor)
      ? await scopedSnapshot(visitor)
      : await archive.read();
    return deliverArchiveJson(analysisExport(family, revision, new Date().toISOString()),
      url.searchParams.get("download") === "1"
        ? 'attachment; filename="drevo-family.json"' : undefined);
  };
}
