import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { settingsStore } from "./settings.ts";
import { peopleSearchStore } from "./people-search.ts";
import { analysisExport } from "../domain/analysis-export.ts";
import { personDetails, archivePageSize } from "../domain/archive-projection.ts";

export function archiveQueryHttp({
  archive,
  auth,
  visibility,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  visibility: ReturnType<typeof settingsStore>;
}) {
  const searchPeople = peopleSearchStore(archive.db);
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
      readTree = auth.canRead(req) || settings.publicTree,
      readPhotos = auth.canRead(req) || settings.publicAlbums;
    const data = archive.read();
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
      reverseTimeline: settings.reverseTimeline,
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
      path !== "/api/export.json" &&
      path !== "/api/family" &&
      path !== "/api/export"
    )
      return false;

    const visitor = auth.currentUser(req),
      access = visibility.read();

    if (path === "/api/family") {
      if (req.method !== "GET") return false;
      if (!auth.canRead(req) && !access.publicTree && !access.publicAlbums)
        return json(res, 401, { error: "Sign in to view this archive" });
      const projection = url.searchParams.get("projection");
      if (projection === "page") {
        const meta = archive.meta(),
          readTree = auth.canRead(req) || access.publicTree,
          readPhotos = auth.canRead(req) || access.publicAlbums,
          pageToken = `${meta.revision}:${Number(readTree)}:${Number(readPhotos)}`;
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
        if (collection === "people")
          return json(res, 200, {
            pageToken,
            items: readTree
              ? archive.peoplePage(offset, archivePageSize).map(personDetails)
              : [],
            total: readTree ? meta.people : 0,
          });
        return json(res, 200, {
          pageToken,
          items: readPhotos
            ? archive
                .photoPage(offset, archivePageSize)
                .map((photo) => (readTree ? photo : { ...photo, tags: [] }))
            : [],
          total: readPhotos ? meta.photos : 0,
        });
      }
      if (projection === "overview") {
        const readTree = auth.canRead(req) || access.publicTree,
          readPhotos = auth.canRead(req) || access.publicAlbums;
        let data: ReturnType<typeof archive.overview>;
        if (readTree) data = archive.overview(readPhotos);
        else {
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
        const pageToken = `${data.revision}:${Number(readTree)}:${Number(readPhotos)}`;
        return json(res, 200, {
          family: data.family,
          revision: data.revision,
          canEdit: auth.canEdit(req),
          local: auth.local,
          user: visitor,
          readTree,
          readPhotos,
          reverseTimeline: access.reverseTimeline,
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
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length > 100)
        return json(res, 400, { error: "Слишком длинный поисковый запрос" });
      return json(res, 200, searchPeople(query));
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Ожидается GET" });
    }
    if (!auth.canRead(req) && !access.publicTree)
      return json(res, 401, { error: "Войдите для экспорта древа" });
    const { family, revision } = archive.read();
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
