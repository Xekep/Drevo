import type { IncomingMessage, ServerResponse } from "node:http";
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

export function archiveQueryHttp({
  archive,
  auth,
  visibility,
  treePreferences,
  researchCatalog,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  treePreferences: ReturnType<typeof treePreferencesStore>;
  researchCatalog: ReturnType<typeof researchCatalogStore>;
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
      user: user
        ? { ...user, platformAdmin: await auth.isPlatformAdmin(req) }
        : null,
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
    const startRevision = scoped
      ? Number((await revisionQuery.get())?.revision)
      : null;
    const canDeliver = async () => await archive.db.transaction(async () => {
      const current = await auth.currentUser(req);
      const settings = await visibility.read();
      const revisionCurrent = !scoped ||
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
    }, true);
    const changed = () => json(res, 409, {
      error: "Архив или доступ к нему изменились. Повторите запрос.",
    });

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
      if (!(await canDeliver())) return changed();
      return json(res, 200, { categories });
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
        if (!(await canDeliver())) return changed();
        return json(res, 200, page);
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
        const platformAdmin = visitor ? await auth.isPlatformAdmin(req) : false;
        if (!(await canDeliver())) return changed();
        return json(res, 200, {
          family: data.family,
          revision: data.revision,
          canEdit,
          local: auth.local,
          user: visitor
            ? { ...visitor, platformAdmin }
            : null,
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
      if (!(await canDeliver())) return changed();
      return json(res, 200, prepared);
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
      if (!(await canDeliver())) return changed();
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="drevo-archive.json"',
      );
      return json(res, 200, prepared.family);
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
      if (!(await canDeliver())) return changed();
      return json(res, 200, matches);
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
    if (!(await canDeliver())) return changed();
    if (url.searchParams.get("download") === "1")
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="drevo-family.json"',
      );
    return json(
      res,
      200,
      analysisExport(family, revision, new Date().toISOString()),
    );
  };
}
