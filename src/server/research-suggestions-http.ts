import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { fullName } from "../domain/dates.ts";
import { ConflictError, type openArchive } from "./database.ts";
import {
  applyResearchSuggestion,
  type researchSuggestionStore,
} from "./research-suggestions.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";

export function researchSuggestionsHttp({
  archive,
  auth,
  suggestions,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  suggestions: ReturnType<typeof researchSuggestionStore>;
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
    if (
      url.pathname !== "/api/research/suggestions" &&
      !url.pathname.startsWith("/api/research/suggestions/")
    )
      return false;

    const actor = await auth.currentUser(req);
    if (!actor || !(await auth.canEdit(req)))
      return json(res, actor ? 403 : 401, {
        error: "Предложения доступны пользователям с правом редактирования",
      });

    if (url.pathname === "/api/research/suggestions" && req.method === "GET") {
      const people = new Map(
        (await archive.read()).family.people.map((person) => [
          person.id,
          person,
        ]),
      );
      return json(res, 200, {
        suggestions: (await suggestions.list(actor)).map((suggestion) => ({
          ...suggestion,
          personName:
            suggestion.kind === "person_create"
              ? fullName(suggestion.payload.person)
              : people.has(suggestion.personId)
                ? fullName(people.get(suggestion.personId)!)
                : "Удалённая карточка",
          ...(suggestion.kind === "relation"
            ? {
                fromName: people.has(suggestion.payload.fromPersonId)
                  ? fullName(people.get(suggestion.payload.fromPersonId)!)
                  : "Удалённая карточка",
                toName: people.has(suggestion.payload.toPersonId)
                  ? fullName(people.get(suggestion.payload.toPersonId)!)
                  : "Удалённая карточка",
              }
            : {}),
        })),
      });
    }

    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });

    const match =
      /^\/api\/research\/suggestions\/([^/]+)\/(accept|reject)$/.exec(
        url.pathname,
      );
    if (!match) return json(res, 404, { error: "Предложение не найдено" });

    try {
      const id = decodeURIComponent(match[1]);
      if (match[2] === "reject")
        return json(res, 200, {
          suggestion: await suggestions.mark(actor, id, "rejected"),
        });

      const suggestion = await suggestions.get(actor, id);
      if (!suggestion) throw new Error("Предложение не найдено");
      if (suggestion.status !== "pending")
        throw new Error("Предложение уже обработано");
      const current = await archive.read(),
        next = applyResearchSuggestion(current.family, suggestion),
        saved = await archive.write(
          next,
          current.revision,
          actor,
          "research_suggestion_accept",
          current.family,
        );
      await suggestions.mark(actor, id, "accepted");
      return json(res, 200, {
        suggestion: await suggestions.get(actor, id),
        revision: saved.revision,
      });
    } catch (error) {
      const status =
        error instanceof ConflictError
          ? 409
          : error instanceof ForbiddenError
            ? 403
            : /изменилась после/.test((error as Error).message)
              ? 409
              : 400;
      return json(res, status, { error: (error as Error).message });
    }
  };
}
