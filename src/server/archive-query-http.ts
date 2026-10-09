import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { settingsStore } from "./settings.ts";
import type { treePreferencesStore } from "./tree-preferences.ts";
import type { researchCatalogStore } from "./research-catalog.ts";
import type { ResearchDirectoryCategory } from "../shared/research-catalog.ts";
import { peopleSearchStore } from "./people-search.ts";
import { scopedArchiveReader } from "./scoped-archive-reader.ts";
import { analysisExport } from "../domain/analysis-export.ts";
import {
  archiveOverview,
  personDetails,
  archivePageSize,
} from "../domain/archive-projection.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { isArchiveOwner } from "../domain/access.ts";
import { DEFAULT_TREE_PREFERENCES } from "../domain/tree-preferences.ts";
import { requestClientKey } from "./request-rate-limit.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";
import { AccountSessionBusy, AccountSessionExpired, assertActiveAccountSession } from "./account-session-guard.ts";
import { accountAiAccess } from "./account-ai-access.ts";
import { memberPreviewTarget, assertMemberPreviewStoreDelivery } from "./member-preview-access.ts";
import { publicPersonId } from "./public-person-id.ts";

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
  const scopedIds = scopedArchiveReader(archive);
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
    aiAvailable: !memberPreviewTarget(req) && user.approved === true && isArchiveOwner(user)
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
      data.family.unions = [];
      data.family.photos = data.family.photos?.map((photo) => ({
        ...photo,
        tags: [],
      }));
    }
    if (!readPhotos) {
      data.family.photos = [];
    }
    return {
      ...data,
      canEdit: await auth.canEdit(req),
      local: auth.local && !memberPreviewTarget(req),
      user: await exposedUser(req, user),
      ...(memberPreviewTarget(req) && user
        ? { participantPreview: { id: user.id, name: user.name } } : {}),
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
      path !== "/api/account/portrait" &&
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
    const stableRevision = !!memberPreviewTarget(req) || scoped || path === "/api/account/portrait" || path === "/api/export" || path === "/api/export.json" ||
      (path === "/api/people/search" && !memberCanRead);
    const startRevision = stableRevision
      ? Number((await revisionQuery.get())?.revision)
      : null;
    const accessStillCurrent = async (expectedRevision = startRevision) => {
      const current = await auth.currentUser(req);
      const settings = await visibility.read();
      const revisionCurrent = expectedRevision === null ||
        (Number.isSafeInteger(expectedRevision) &&
          Number((await revisionQuery.get())?.revision) === expectedRevision);
      return revisionCurrent &&
        current?.id === visitor?.id &&
        current?.role === visitor?.role &&
        current?.approved === visitor?.approved &&
        current?.personId === visitor?.personId &&
        current?.treeAccess === visitor?.treeAccess &&
        current?.archiveOwner === visitor?.archiveOwner &&
        settings.publicTree === access.publicTree &&
        settings.publicAlbums === access.publicAlbums;
    };
    const canDeliver = async (expectedRevision: number | null) => {
      const valid = await archive.db.transaction(async () => {
        return await accessStillCurrent(expectedRevision);
      }, true);
      await beforeDelivery?.();
      return valid;
    };
    const changed = () => json(res, 409, {
      error: "Архив или доступ к нему изменились. Повторите запрос.",
    });
    const deliverArchiveJson = async (value: unknown, contentDisposition?: string,
      expectedRevision = startRevision) => {
      if (archive.db.kind !== "postgres") {
        if (!await canDeliver(expectedRevision)) return changed();
        if (contentDisposition) res.setHeader("Content-Disposition", contentDisposition);
        return json(res, 200, value);
      }
      // A large projection is serialized before taking the archive lock.
      const body = JSON.stringify(value);
      await beforeDelivery?.();
      const valid = await archive.db.transaction(async () => {
        let previewExpiresAt: number | null = null;
        // Archive writes and visibility changes lock this row first. A session
        // deletion may lock its session first, so do not wait for that row.
        if (visitor && !auth.local) {
          const session = await auth.accountSession(req);
          if (!session) return false;
          if (memberPreviewTarget(req)) {
            if (visitor.id !== memberPreviewTarget(req)) return false;
            previewExpiresAt = await assertMemberPreviewStoreDelivery(archive.db,
              session, visitor);
            if (!previewExpiresAt) return false;
          } else {
            if (session.accountId !== visitor.id) return false;
            await assertActiveAccountSession(archive.db, visitor.id, session.tokenHash);
            const archiveId = archive.db.archiveId;
            if (!archiveId) return false;
            const membership = await archive.db.prepare("", `SELECT 1 FROM archive_memberships
              WHERE archive_id=? AND user_id=? FOR SHARE`).get(archiveId, visitor.id);
            if (!membership) return false;
          }
        }
        if (!await accessStillCurrent(expectedRevision)) return false;
        await beforeLockedDelivery?.();
        if (res.destroyed) return true;
        const remaining = previewExpiresAt
          ? Math.min(5_000, previewExpiresAt - Date.now()) : 5_000;
        if (remaining <= 0) return false;
        if (previewExpiresAt && Date.now() >= previewExpiresAt) return false;
        const delivered = finished(res, { cleanup: true });
        const timeout = setTimeout(() => res.destroy(), remaining);
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

    if (path === "/api/account/portrait") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return json(res, 405, { error: "Ожидается GET" });
      }
      if (!memberCanRead || memberPreviewTarget(req))
        return json(res, 401, { error: "Войдите для просмотра своего портрета" });
      const row = visitor?.personId ? await archive.db.prepare(
        "SELECT json_extract(data,'$.photo') AS photo FROM people WHERE id=?",
        "SELECT data->>'photo' AS photo FROM people WHERE id=? AND archive_id=current_setting('drevo.archive_id',true)",
      ).get(visitor.personId) : undefined;
      return deliverArchiveJson({ personId: visitor?.personId || null,
        photo: typeof row?.photo === "string" ? row.photo : null });
    }

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
      if (projection === "details") {
        if (!memberCanRead && !access.publicTree)
          return json(res, 401, { error: "Войдите для просмотра людей" });
        let ids: unknown;
        try {
          ids = JSON.parse(url.searchParams.get("ids") || "null");
        } catch {
          return json(res, 400, { error: "Некорректные идентификаторы" });
        }
        const offset = Number(url.searchParams.get("offset") || "0");
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > archivePageSize ||
          !ids.every(publicPersonId) ||
          new Set(ids).size !== ids.length ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          return json(res, 400, { error: "Некорректный запрос сведений" });
        const requested = new Set(ids as string[]);
        const readPhotos = memberCanRead || access.publicAlbums;
        const prepared = await archive.db.transaction(async () => {
          const meta = await archive.meta();
          const pageToken = `${meta.revision}:1:${Number(readPhotos)}:${visitor?.id || "guest"}:${visitor?.personId || ""}:${visitor?.treeAccess || "all"}`;
          if (url.searchParams.get("token") !== pageToken) return null;
          const visible = isScopedUser(visitor)
            ? await scopedIds(visitor)
            : null;
          if (visible && [...requested].some((id) => !visible.has(id)))
            return { missing: true } as const;
          const people = await archive.peoplePage(0, requested.size, requested);
          if (people.length !== requested.size)
            return { missing: true } as const;
          const scope = visible ? { visible, userId: visitor!.id } : undefined;
          return {
            revision: meta.revision,
            pageToken,
            people: people.map(personDetails),
            photos: readPhotos
              ? await archive.photoPage(
                  offset,
                  archivePageSize,
                  scope,
                  requested,
                )
              : [],
            photoTotal: readPhotos
              ? await archive.photoCount(scope, requested)
              : 0,
          };
        }, true);
        if (!prepared) return changed();
        if ("missing" in prepared)
          return json(res, 404, { error: "Человек не найден или недоступен" });
        return deliverArchiveJson(prepared, undefined, prepared.revision);
      }
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
            ? await scopedIds(visitor)
            : null;
          if (collection === "people")
            return {
              revision: meta.revision,
              pageToken,
              items: readTree
                ? (scoped
                    ? await archive.peoplePage(offset, archivePageSize, scoped)
                    : await archive.peoplePage(offset, archivePageSize)
                  ).map(personDetails)
                : [],
              total: readTree ? (scoped?.size ?? meta.people) : 0,
            };
          return {
            revision: meta.revision,
            pageToken,
            items: readPhotos
              ? (scoped
                  ? await archive.photoPage(offset, archivePageSize, { visible: scoped, userId: visitor!.id })
                  : await archive.photoPage(offset, archivePageSize)
                ).map((photo) => (readTree ? photo : { ...photo, tags: [] }))
              : [],
            total: readPhotos ? (scoped ? await archive.photoCount({ visible: scoped, userId: visitor!.id }) : meta.photos) : 0,
          };
        }, true);
        if (!page)
          return json(res, 409, {
            error: "Архив или доступ к нему изменились. Обновите данные.",
          });
        const { revision: preparedRevision, ...publicPage } = page;
        return deliverArchiveJson(publicPage, undefined,
          memberCanRead ? startRevision : preparedRevision);
      }
      if (projection === "overview") {
        const readTree = memberCanRead || access.publicTree,
          readPhotos = memberCanRead || access.publicAlbums;
        let data: Awaited<ReturnType<typeof archive.overview>>;
        if (readTree) {
          if (isScopedUser(visitor)) {
            const overview = await archive.overview();
            const scoped = projectFamilyForUser(overview.family, visitor);
            const ids = new Set(scoped.people.map(person => person.id));
            data = {
              family: archiveOverview(scoped),
              revision: overview.revision,
              totals: {
                people: scoped.people.length,
                photos: await archive.photoCount({ visible: ids, userId: visitor.id }),
              },
            };
          } else data = await archive.overview(readTree);
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
          local: auth.local && !memberPreviewTarget(req),
          user: await exposedUser(req, visitor),
          ...(memberPreviewTarget(req) && visitor
            ? { participantPreview: { id: visitor.id, name: visitor.name } } : {}),
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
        }, undefined, memberCanRead ? startRevision : data.revision);
      }
      const prepared = await snapshot(req, visitor, access);
      return deliverArchiveJson(prepared, undefined,
        memberCanRead ? startRevision : prepared.revision);
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
        ? await scopedIds(visitor)
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
