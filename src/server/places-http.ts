import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { settingsStore } from "./settings.ts";
import type { GeocodingStore } from "./geocoding.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { familyPlaces, placeKey } from "../domain/places.ts";

export function placesHttp({
  archive,
  auth,
  visibility,
  geocoding,
  publicOrigin,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  visibility: ReturnType<typeof settingsStore>;
  geocoding: () => GeocodingStore;
  publicOrigin?: string;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/api/places/locate") return false;
    if (req.method !== "GET")
      return json(res, 405, { error: "Ожидается GET" });

    const visitor = auth.currentUser(req),
      access = visibility.read();
    if (!visitor && !access.publicTree && !access.publicAlbums)
      return json(res, 401, { error: "Войдите для просмотра мест семьи" });
    if (
      req.headers["x-drevo-map"] !== "1" ||
      !isSameOriginRequest(req, publicOrigin)
    )
      return json(res, 403, { error: "Откройте карту в архиве" });

    const query = (url.searchParams.get("q") || "").trim();
    const permittedQuery = () => {
      if (auth.canEdit(req)) return true;
      const currentUser = auth.currentUser(req),
        settings = visibility.read(),
        { family } = archive.read(),
        people = currentUser || settings.publicTree ? family.people : [],
        photos = currentUser || settings.publicAlbums ? family.photos : [];
      return familyPlaces(people, photos).some(
        (place) => place.key === placeKey(query),
      );
    };

    if (!permittedQuery())
      return json(res, 403, {
        error: "Можно искать только места из доступного архива",
      });
    try {
      const result = await geocoding().locate(query);
      if (!permittedQuery())
        return json(res, 403, { error: "Доступ к этому месту закрыт" });
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  };
}
