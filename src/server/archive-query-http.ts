import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { settingsStore } from "./settings.ts";
import { peopleSearchStore } from "./people-search.ts";
import { analysisExport } from "../domain/analysis-export.ts";

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

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (path !== "/api/people/search" && path !== "/api/export.json")
      return false;

    const visitor = auth.currentUser(req),
      access = visibility.read();

    if (path === "/api/people/search") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      if (!visitor && !access.publicTree)
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
    if (!visitor && !access.publicTree)
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
