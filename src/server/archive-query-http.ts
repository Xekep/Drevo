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
import {
  createRequestLimiter,
  requestClientKey,
} from "./request-rate-limit.ts";

export function archiveQueryHttp({
  archive,
  auth,
  visibility,
  treePreferences,
  researchCatalog,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  visibility: ReturnType<typeof settingsStore>;
  treePreferences: ReturnType<typeof treePreferencesStore>;
  researchCatalog: ReturnType<typeof researchCatalogStore>;
}) {
  const searchPeople = peopleSearchStore(archive.db);
  const publicSearchLimiter = createRequestLimiter({
    windowMs: 60_000,
    limit: 60,
  });
  let scopedCache: {
    key: string;
    family: ReturnType<typeof archive.read>["family"];
  } | null = null;
  const scopedFamily = (
    user: NonNullable<ReturnType<typeof auth.currentUser>>,
  ) => {
    const key = `${archive.meta().revision}:${user.id}:${user.personId || ""}`;
    if (scopedCache?.key !== key)
      scopedCache = {
        key,
        family: projectFamilyForUser(archive.read().family, user),
      };
    return scopedCache.family;
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const snapshot = (req: IncomingMessage) => {
    const user = auth.currentUser(req),
      settings = visibility.read(),
      personalPreferences = user ? treePreferences.read(user.id) : null,
      readTree = auth.canRead(req) || settings.publicTree,
      readPhotos = auth.canRead(req) || settings.publicAlbums;
    const data = isScopedUser(user)
      ? {
          family: structuredClone(scopedFamily(user)),
          revision: archive.meta().revision,
        }
      : archive.read();
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
      canEdit: auth.canEdit(req),
      local: auth.local,
      user,
      readTree,
      readPhotos,
      reverseTimeline:
        personalPreferences?.reverseTimeline ?? settings.reverseTimeline,
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

    const visitor = auth.currentUser(req),
      access = visibility.read();

    if (path === "/api/research-resources") {
      if (!auth.canRead(req) && !access.publicTree)
        return json(res, 401, { error: "Войдите, чтобы открыть справочник" });
      if (req.method !== "GET")
        return json(res, 405, {
          error: "Справочник доступен только для чтения",
        });
      const categories: ResearchDirectoryCategory[] = researchCatalog
        .list()
        .map(({ id, name, resources }) => ({
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
      return json(res, 200, { categories });
    }

    if (path === "/api/family") {
      if (req.method !== "GET") return false;
      if (!auth.canRead(req) && !access.publicTree && !access.publicAlbums)
        return json(res, 401, { error: "Sign in to view this archive" });
      const projection = url.searchParams.get("projection");
      if (projection === "page") {
        const meta = archive.meta(),
          readTree = auth.canRead(req) || access.publicTree,
          readPhotos = auth.canRead(req) || access.publicAlbums,
          pageToken = `${meta.revision}:${Number(readTree)}:${Number(readPhotos)}:${visitor?.id || "guest"}:${visitor?.personId || ""}:${visitor?.treeAccess || "all"}`;
        if (url.searchParams.get("token") !== pageToken)
          return json(res, 409, {
            error: "Архив или доступ к нему изменились. Обновите данные.",
          });
        const collection = url.searchParams.get("collection"),
          offset = Number(url.searchParams.get("offset"));
        if (
          !["people", "photos"].includes(collection || "") ||
          !Number.isInteger(offset) ||
          offset < 0
        )
          return json(res, 400, { error: "Некорректная страница" });
        const scoped = isScopedUser(visitor) ? scopedFamily(visitor) : null;
        if (collection === "people")
          return json(res, 200, {
            pageToken,
            items: readTree
              ? (scoped
                  ? scoped.people.slice(offset, offset + archivePageSize)
                  : archive.peoplePage(offset, archivePageSize)
                ).map(personDetails)
              : [],
            total: readTree ? (scoped?.people.length ?? meta.people) : 0,
          });
        return json(res, 200, {
          pageToken,
          items: readPhotos
            ? (scoped
                ? (scoped.photos || []).slice(offset, offset + archivePageSize)
                : archive.photoPage(offset, archivePageSize)
              ).map((photo) => (readTree ? photo : { ...photo, tags: [] }))
            : [],
          total: readPhotos ? (scoped?.photos?.length ?? meta.photos) : 0,
        });
      }
      if (projection === "overview") {
        const readTree = auth.canRead(req) || access.publicTree,
          readPhotos = auth.canRead(req) || access.publicAlbums;
        let data: ReturnType<typeof archive.overview>;
        if (readTree) {
          if (isScopedUser(visitor)) {
            const scoped = scopedFamily(visitor);
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
              revision: archive.meta().revision,
              totals: {
                people: scoped.people.length,
                photos: scoped.photos?.length || 0,
              },
            };
          } else data = archive.overview(readPhotos);
        } else {
          const meta = archive.meta();
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
          ? treePreferences.read(visitor.id)
          : null;
        const pageToken = `${data.revision}:${Number(readTree)}:${Number(readPhotos)}:${visitor?.id || "guest"}:${visitor?.personId || ""}:${visitor?.treeAccess || "all"}`;
        return json(res, 200, {
          family: data.family,
          revision: data.revision,
          canEdit: auth.canEdit(req),
          local: auth.local,
          user: visitor,
          readTree,
          readPhotos,
          reverseTimeline:
            personalPreferences?.reverseTimeline ?? access.reverseTimeline,
          treePreferences: personalPreferences,
          partial: true,
          pageToken,
          totals: {
            people: readTree ? data.totals.people : 0,
            photos: readPhotos ? data.totals.photos : 0,
          },
        });
      }
      return json(res, 200, snapshot(req));
    }

    if (path === "/api/export") {
      if (req.method !== "GET") return false;
      if (!auth.canRead(req) && !access.publicTree && !access.publicAlbums)
        return json(res, 401, { error: "Sign in to view this archive" });
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="drevo-archive.json"',
      );
      return json(res, 200, snapshot(req).family);
    }

    if (path === "/api/people/search") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      if (!auth.canRead(req) && !access.publicTree)
        return json(res, 401, { error: "Войдите для поиска людей" });
      if (
        !auth.canRead(req) &&
        !publicSearchLimiter.allow(
          requestClientKey(req.headers["x-real-ip"], req.socket.remoteAddress),
        )
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
        ? new Set(scopedFamily(visitor).people.map((person) => person.id))
        : undefined;
      return json(res, 200, searchPeople(query, visible));
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Ожидается GET" });
    }
    if (!auth.canRead(req) && !access.publicTree)
      return json(res, 401, { error: "Войдите для экспорта древа" });
    const { family, revision } = isScopedUser(visitor)
      ? { family: scopedFamily(visitor), revision: archive.meta().revision }
      : archive.read();
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
