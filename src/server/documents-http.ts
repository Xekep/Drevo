import { enforceUserStorageLimit } from "./storage-limits.ts";
import { httpByteRange } from "./http-byte-range.ts";
import {
  documentFileTypeFromMime,
  storedDocumentFileType,
} from "../shared/document-file.ts";
import { imageExtension } from "./media.ts";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { readFile, rename, stat, statfs, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import type { mediaStore } from "./media.ts";
import { fullName } from "../domain/index.ts";
import type { Person } from "../domain/types.ts";
import {
  parseDocumentEventLinks,
  parseDocumentPages,
} from "../shared/document-links.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { owns } from "../domain/access.ts";
import {
  validAnnotationSelection,
  type AnnotationSelection,
  type DocumentAnnotation,
} from "../shared/document-annotations.ts";
import { auditStore } from "./audit.ts";
import { uploadQuota, UploadQuotaError } from "./upload-quota.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import {
  documentSearchText,
  parseDocumentDetails,
  type DocumentDetails,
} from "../shared/document-details.ts";

async function readJsonBody(
  req: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type Row = {
  id: string;
  title: string;
  document_type: string;
  document_date: string;
  place: string;
  description: string;
  provenance: string;
  file_name: string;
  file_size: number;
  created_at: string;
  uploaded_by: string;
  annotations: string;
  event_links: string;
  pages: string;
};

function rowDetails(row: Row): DocumentDetails {
  return {
    documentType: row.document_type,
    documentDate: row.document_date,
    place: row.place,
    description: row.description,
    provenance: row.provenance,
  };
}

type DocumentVersion = DocumentDetails & { title: string };

function parsedVersion(value: unknown): DocumentVersion | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const details = parseDocumentDetails(input);
  return title && title.length <= 160 && details ? { title, ...details } : null;
}

function personIdsInput(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 30 &&
    value.every((id) => typeof id === "string" && !!id && id.length <= 200) &&
    new Set(value).size === value.length
  );
}

const editableFields: Array<[keyof DocumentVersion, string]> = [
  ["title", "Название"],
  ["documentType", "Тип"],
  ["documentDate", "Дата или период"],
  ["place", "Место"],
  ["description", "Описание"],
  ["provenance", "Происхождение"],
];

function listedDocument(
  row: Row,
  linkedIds: string[],
  people: Map<string, string>,
  canDelete: boolean,
  visiblePeople: Person[] = [],
) {
  const eventLinks = (parseDocumentEventLinks(JSON.parse(row.event_links || "[]")) || [])
    .filter((link) => linkedIds.includes(link.personId) &&
      visiblePeople.some((person) => person.id === link.personId &&
        person.events?.some((event) => event.id === link.eventId)))
    .map((link) => {
      const person = visiblePeople.find((item) => item.id === link.personId)!;
      const event = person.events!.find((item) => item.id === link.eventId)!;
      return { ...link, personName: fullName(person), eventTitle: event.title || event.type };
    });
  const sources = visiblePeople.flatMap((person) => [
    ...person.sources.filter((source) => source.documentId === row.id)
      .map((source) => ({ personId: person.id, personName: fullName(person),
        title: source.title, reference: source.reference,
        page: source.documentPage })),
    ...(person.events || []).flatMap((event) => (event.sources || [])
      .filter((source) => source.documentId === row.id)
      .map((source) => ({ personId: person.id, personName: fullName(person),
        eventId: event.id, eventTitle: event.title || event.type,
        title: source.title, reference: source.reference,
        page: source.documentPage }))),
  ]);
  return {
    id: row.id,
    title: row.title,
    documentType: row.document_type,
    documentDate: row.document_date,
    place: row.place,
    description: row.description,
    provenance: row.provenance,
    size: row.file_size,
    mimeType: storedDocumentFileType(row.file_name)?.mime || "application/pdf",
    createdAt: row.created_at,
    canDelete,
    url: `/api/documents/${row.id}/file`,
    people: linkedIds
      .filter((id) => people.has(id))
      .map((id) => ({ id, name: people.get(id)! })),
    eventLinks,
    pages: parseDocumentPages(JSON.parse(row.pages || "[]")) || [],
    sources,
  };
}

export function documentsHttp({
  archive,
  auth,
  media,
  uploadsDirectory,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  media: ReturnType<typeof mediaStore>;
  uploadsDirectory: string;
  publicOrigin?: string;
}) {
  mkdirSync(uploadsDirectory, { recursive: true });
  const db = archive.db;
  const quota = uploadQuota(db);
  const audit = auditStore(db);
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const accessScope = (user: Awaited<ReturnType<typeof auth.currentUser>>) =>
    user?.approved
      ? JSON.stringify([user.id, user.role, user.treeAccess, user.personId])
      : null;
  const visible = async (req: IncomingMessage, includePeople = true) => {
    const user = await auth.currentUser(req);
    const scope = accessScope(user);
    const scoped = isScopedUser(user);
    const people = !scope || (!scoped && !includePeople)
      ? []
      : scoped
        ? projectFamilyForUser((await archive.read()).family, user).people
        : (await archive.read()).family.people;
    return {
      userId: user?.id,
      scope,
      scoped,
      people,
      ids: people.map((person) => person.id),
    };
  };
  const accessStillCurrent = async (
    req: IncomingMessage,
    access: Awaited<ReturnType<typeof visible>>,
  ) => !!access.scope && accessScope(await auth.currentUser(req)) === access.scope;
  const linkedPersons = async (ids: string[]) => {
    if (!ids.length) return [] as Person[];
    const rows = await db.prepare(
      "SELECT id,data FROM people WHERE id IN (SELECT value FROM json_each(?))",
      "SELECT id,data FROM people WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))",
    ).all(JSON.stringify([...new Set(ids)]));
    return rows.map((row) => (typeof row.data === "string"
      ? JSON.parse(row.data) : row.data) as Person);
  };
  const matchingPersonIds = async (query: string) => {
    const rows = await db.prepare(
      "SELECT p.id,p.data FROM (SELECT DISTINCT person_id FROM document_people) dp JOIN people p ON p.id=dp.person_id",
      "SELECT p.id,p.data FROM (SELECT DISTINCT person_id FROM document_people) dp JOIN people p ON p.id=dp.person_id",
    ).all();
    return rows.filter((row) => {
      const person = (typeof row.data === "string"
        ? JSON.parse(row.data) : row.data) as Person;
      return fullName(person).toLocaleLowerCase("ru").includes(query);
    }).map((row) => String(row.id));
  };
  const referencingPeople = async (documentId: string) => {
    // The citation lives inside person JSON until sources become first-class rows.
    // Narrow the occasional delete check before inspecting nested sources.
    const rows = await db.prepare(
      "SELECT id,data FROM people WHERE data LIKE ?",
      "SELECT id,data FROM people WHERE data::text LIKE ?",
    ).all(`%${documentId}%`);
    return rows.flatMap((row) => {
      const person = (typeof row.data === "string"
        ? JSON.parse(row.data) : row.data) as Person;
      const linked = person.sources.some((source) => source.documentId === documentId) ||
        (person.events || []).some((event) =>
          (event.sources || []).some((source) => source.documentId === documentId));
      return linked ? [String(row.id)] : [];
    });
  };
  const canSee = (
    access: Awaited<ReturnType<typeof visible>>,
    row: Row,
    ids: string[],
  ) =>
    !!access.scope && (
      !access.scoped ||
      ids.some((id) => access.ids.includes(id)) ||
      (!ids.length && row.uploaded_by === access.userId)
    );
  const associations = async (ids: string[]) => {
    if (!ids.length) return new Map<string, string[]>();
    const rows = (await db
      .prepare(
        `SELECT document_id,person_id FROM document_people
       WHERE document_id IN (${ids.map(() => "?").join(",")})
       ORDER BY person_id`,
        `SELECT document_id,person_id FROM document_people
       WHERE document_id IN (${ids.map(() => "?").join(",")})
       ORDER BY person_id`,
      )
      .all(...ids)) as Array<{ document_id: string; person_id: string }>;
    const result = new Map<string, string[]>();
    for (const row of rows)
      result.set(row.document_id, [
        ...(result.get(row.document_id) || []),
        row.person_id,
      ]);
    return result;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const list = url.pathname === "/api/documents";
    const file = /^\/api\/documents\/([a-f0-9-]{36})\/file$/.exec(url.pathname);
    const item = /^\/api\/documents\/([a-f0-9-]{36})$/.exec(url.pathname);
    const annotations =
      /^\/api\/documents\/([a-f0-9-]{36})\/annotations(?:\/([a-f0-9-]{36}))?$/.exec(
        url.pathname,
      );
    if (!list && !file && !item && !annotations) return false;
    if (!(await auth.canRead(req)))
      return json(res, 401, { error: "Войдите, чтобы открыть документы" });

    if (list && req.method === "GET") {
      const offset = Number(url.searchParams.get("offset") || 0),
        limit = Number(url.searchParams.get("limit") || 30),
        personId = url.searchParams.get("personId"),
        query = (url.searchParams.get("q") || "")
          .trim()
          .toLocaleLowerCase("ru");
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (personId !== null && (!personId || personId.length > 200)) ||
        query.length > 100
      )
        return json(res, 400, { error: "Некорректная страница" });
      const access = await visible(req, false);
      if (!access.scope)
        return json(res, 403, { error: "Доступ к документам изменился" });
      if (personId !== null && access.scoped && !access.ids.includes(personId))
        return json(res, 200, { total: 0, items: [] });
      const conditions: string[] = [];
      const args: string[] = [];
      if (personId !== null) {
        conditions.push(
          "EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id=?)",
        );
        args.push(personId);
      }
      if (access.scoped) {
        conditions.push(
          db.kind === "postgres"
            ? "(EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))) OR (d.uploaded_by=? AND NOT EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id)))"
            : "(EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM json_each(?))) OR (d.uploaded_by=? AND NOT EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id)))",
        );
        args.push(JSON.stringify(access.ids), access.userId || "");
      }
      if (query) {
        const peopleIds = access.scoped
          ? access.people
            .filter((person) => fullName(person).toLocaleLowerCase("ru").includes(query))
            .map((person) => person.id)
          : await matchingPersonIds(query);
        conditions.push(
          db.kind === "postgres"
            ? "(strpos(d.title_search, ?) > 0 OR EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))))"
            : "(instr(d.title_search, ?) > 0 OR EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM json_each(?))))",
        );
        args.push(query, JSON.stringify(peopleIds));
      }
      const where = conditions.length
        ? ` WHERE ${conditions.join(" AND ")}`
        : "";
      const total = Number(
        (
          (await db
            .prepare(
              `SELECT count(*) AS count FROM documents d${where}`,
              `SELECT count(*) AS count FROM documents d${where}`,
            )
            .get(...args)) as { count: number }
        ).count,
      );
      const rows = (await db
        .prepare(
          `SELECT d.* FROM documents d${where} ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?`,
          `SELECT d.* FROM documents d${where} ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset)) as Row[];
      const links = await associations(rows.map((row) => row.id));
      const related = access.scoped ? access.people : await linkedPersons([...links.values()].flat());
      const people = new Map(related.map((person) => [person.id, fullName(person)]));
      const actor = await auth.currentUser(req),
        mayEdit = await auth.canEdit(req);
      if (!(await accessStillCurrent(req, access)))
        return json(res, 403, { error: "Доступ к документам изменился" });
      return json(res, 200, {
        total,
        items: rows.map((row) =>
          listedDocument(
            row,
            links.get(row.id) || [],
            people,
            mayEdit && owns(actor, { createdBy: row.uploaded_by }),
            related,
          ),
        ),
      });
    }

    if (item && req.method === "GET") {
      const row = (await db
        .prepare(
          "SELECT * FROM documents WHERE id=?",
          "SELECT * FROM documents WHERE id=?",
        )
        .get(item[1])) as Row | undefined;
      if (!row) return json(res, 404, { error: "Документ не найден" });
      const access = await visible(req, false);
      const linkedIds = (await associations([row.id])).get(row.id) || [];
      if (!canSee(access, row, linkedIds))
        return json(res, 404, { error: "Документ не найден" });
      const related = access.scoped ? access.people : await linkedPersons(linkedIds);
      const people = new Map(related.map((person) => [person.id, fullName(person)]));
      const actor = await auth.currentUser(req);
      const mayEdit = await auth.canEdit(req);
      if (!(await accessStillCurrent(req, access)))
        return json(res, 404, { error: "Документ не найден" });
      return json(
        res,
        200,
        listedDocument(
          row,
          linkedIds,
          people,
          mayEdit && owns(actor, { createdBy: row.uploaded_by }),
          related,
        ),
      );
    }

    if (item && req.method === "PATCH") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      if (!(await auth.canEdit(req)))
        return json(res, 403, { error: "Нет прав на изменение документа" });
      if (
        req.headers["content-type"]?.split(";")[0].trim() !== "application/json"
      )
        return json(res, 415, { error: "Ожидается JSON" });
      let body: unknown;
      try {
        body = await readJsonBody(req, 32_768);
      } catch {
        return json(res, 400, { error: "Некорректные сведения о документе" });
      }
      const input =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const expected = parsedVersion(input.expected);
      const requestedNext = parsedVersion(input.next);
      const links = input.people as
        { expected?: unknown; next?: unknown } | undefined;
      const eventInput = input.eventLinks as
        { expected?: unknown; next?: unknown } | undefined;
      const pageInput = input.pages as
        { expected?: unknown; next?: unknown } | undefined;
      const expectedEvents = eventInput && parseDocumentEventLinks(eventInput.expected);
      const requestedEvents = eventInput && parseDocumentEventLinks(eventInput.next);
      const expectedPages = pageInput && parseDocumentPages(pageInput.expected);
      const requestedPages = pageInput && parseDocumentPages(pageInput.next);
      if (
        (input.expected !== undefined || input.next !== undefined) &&
        (!expected || !requestedNext)
      )
        return json(res, 400, {
          error: "Проверьте название и сведения о документе",
        });
      if (
        (!expected && !links && !eventInput && !pageInput) ||
        (links &&
          (!personIdsInput(links.expected) || !personIdsInput(links.next))) ||
        (eventInput && (!expectedEvents || !requestedEvents)) ||
        (pageInput && (!expectedPages || !requestedPages))
      )
        return json(res, 400, { error: "Некорректные привязки документа" });
      const result = await db.transaction(async () => {
        const actor = await auth.currentUser(req);
        if (!actor?.approved || !(await auth.canEdit(req)))
          return {
            status: 403 as const,
            error: "Нет прав на изменение документа",
          };
        const row = (await db
          .prepare(
            "SELECT * FROM documents WHERE id=?",
            "SELECT * FROM documents WHERE id=?",
          )
          .get(item[1])) as Row | undefined;
        if (!row) return { status: 404 as const, error: "Документ не найден" };
        const access = await visible(req);
        const personIds = (await associations([row.id])).get(row.id) || [];
        if (!canSee(access, row, personIds))
          return { status: 404 as const, error: "Документ не найден" };
        if (!owns(actor, { createdBy: row.uploaded_by }))
          return {
            status: 403 as const,
            error: "Изменить документ может его автор или администратор",
          };
        const previous: DocumentVersion = {
          title: row.title,
          ...rowDetails(row),
        };
        const next = requestedNext || previous;
        if (
          expected &&
          editableFields.some(([field]) => previous[field] !== expected[field])
        )
          return {
            status: 409 as const,
            error: "Документ изменился. Откройте его заново",
          };
        const visibleIds = personIds.filter((id) => access.ids.includes(id));
        let nextIds = personIds;
        if (links) {
          const expectedIds = links.expected as string[],
            requestedIds = links.next as string[];
          if (
            [...expectedIds, ...requestedIds].some(
              (id) => !access.ids.includes(id),
            )
          )
            return {
              status: 403 as const,
              error: "Нет доступа к выбранному человеку",
            };
          if (
            JSON.stringify([...expectedIds].sort()) !==
            JSON.stringify([...visibleIds].sort())
          )
            return {
              status: 409 as const,
              error: "Привязки изменились. Откройте документ заново",
            };
          // A scoped editor cannot remove or learn about links to hidden people.
          nextIds = [
            ...personIds.filter((id) => !access.ids.includes(id)),
            ...requestedIds,
          ];
          if (nextIds.length > 30)
            return {
              status: 400 as const,
              error: "Документ можно связать не более чем с 30 людьми",
            };
        }
        const linksChanged =
          JSON.stringify([...personIds].sort()) !==
          JSON.stringify([...nextIds].sort());
        const previousEvents = parseDocumentEventLinks(JSON.parse(row.event_links || "[]")) || [];
        const validEvents = previousEvents.filter((link) => !access.ids.includes(link.personId) ||
          access.people.some((person) => person.id === link.personId &&
            person.events?.some((event) => event.id === link.eventId)));
        const visibleEvents = validEvents.filter((link) => access.ids.includes(link.personId));
        if (expectedEvents && JSON.stringify(expectedEvents) !== JSON.stringify(visibleEvents))
          return { status: 409 as const, error: "Связи с событиями изменились. Откройте документ заново" };
        const nextEvents = requestedEvents
          ? [...validEvents.filter((link) => !access.ids.includes(link.personId)), ...requestedEvents]
          : validEvents;
        if (nextEvents.length > 100 || nextEvents.some((link) => !nextIds.includes(link.personId)) ||
          (requestedEvents || []).some((link) => !access.people.some((person) =>
            person.id === link.personId && person.events?.some((event) => event.id === link.eventId))))
          return { status: 400 as const, error: "Свяжите событие с видимым человеком документа" };
        const previousPages = parseDocumentPages(JSON.parse(row.pages || "[]")) || [];
        if (expectedPages && JSON.stringify(expectedPages) !== JSON.stringify(previousPages))
          return { status: 409 as const, error: "Страницы изменились. Откройте документ заново" };
        const nextPages = requestedPages || previousPages;
        const eventsChanged = JSON.stringify(previousEvents) !== JSON.stringify(nextEvents);
        const pagesChanged = JSON.stringify(previousPages) !== JSON.stringify(nextPages);
        if (
          !linksChanged &&
          !eventsChanged &&
          !pagesChanged &&
          editableFields.every(([field]) => previous[field] === next[field])
        )
          return {
            status: 200 as const,
            item: listedDocument(
              row,
              personIds,
              new Map(
                access.people.map((person) => [person.id, fullName(person)]),
              ),
              true,
              access.people,
            ),
          };
        if (linksChanged) {
          const citedBy = await referencingPeople(row.id);
          if (citedBy.some((id) => personIds.includes(id) && !nextIds.includes(id)))
            return {
              status: 409 as const,
              error: "Сначала уберите ссылку на документ из источников этого человека или его событий.",
            };
          await db
            .prepare(
              "DELETE FROM document_people WHERE document_id=?",
              "DELETE FROM document_people WHERE document_id=?",
            )
            .run(row.id);
          const insert = db.prepare(
            "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
            "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
          );
          for (const id of nextIds) await insert.run(row.id, id);
        }
        await db
          .prepare(
            "UPDATE documents SET title=?,title_search=?,document_type=?,document_date=?,place=?,description=?,provenance=?,event_links=?,pages=? WHERE id=?",
            "UPDATE documents SET title=?,title_search=?,document_type=?,document_date=?,place=?,description=?,provenance=?,event_links=?,pages=? WHERE id=?",
          )
          .run(
            next.title,
            documentSearchText(next.title, next),
            next.documentType,
            next.documentDate,
            next.place,
            next.description,
            next.provenance,
            JSON.stringify(nextEvents),
            JSON.stringify(nextPages),
            row.id,
          );
        await audit.record(
          {
            action: "Изменён документ",
            entity: "document",
            entityId: row.id,
            label: next.title,
            personIds: [...new Set([...personIds, ...nextIds])],
            details: [
              ...editableFields
                .filter(([field]) => previous[field] !== next[field])
                .map(([field, label]) => ({
                  field: label,
                  before: previous[field],
                  after: next[field],
                })),
              ...(linksChanged
                ? [
                    {
                      field: "Привязки к людям",
                      before: visibleIds
                        .map((id) =>
                          fullName(access.people.find((p) => p.id === id)!),
                        )
                        .join(", "),
                      after: nextIds
                        .filter((id) => access.ids.includes(id))
                        .map((id) =>
                          fullName(access.people.find((p) => p.id === id)!),
                        )
                        .join(", "),
                    },
                  ]
                : []),
              ...(eventsChanged ? [{ field: "Связи с событиями", before: String(visibleEvents.length), after: String(nextEvents.filter((link) => access.ids.includes(link.personId)).length) }] : []),
              ...(pagesChanged ? [{ field: "Описания страниц", before: String(previousPages.length), after: String(nextPages.length) }] : []),
            ],
          },
          actor,
        );
        const updated = {
          ...row,
          title: next.title,
          document_type: next.documentType,
          document_date: next.documentDate,
          place: next.place,
          description: next.description,
          provenance: next.provenance,
          event_links: JSON.stringify(nextEvents),
          pages: JSON.stringify(nextPages),
        };
        return {
          status: 200 as const,
          item: listedDocument(
            updated,
            nextIds,
            new Map(
              access.people.map((person) => [person.id, fullName(person)]),
            ),
            true,
            access.people,
          ),
        };
      });
      return "error" in result
        ? json(res, result.status, { error: result.error })
        : json(res, result.status, result.item);
    }

    if (annotations) {
      const row = (await db
        .prepare(
          "SELECT * FROM documents WHERE id=?",
          "SELECT * FROM documents WHERE id=?",
        )
        .get(annotations[1])) as Row | undefined;
      if (!row) return json(res, 404, { error: "Документ не найден" });
      const access = await visible(req, false);
      const personIds = (await associations([row.id])).get(row.id) || [];
      if (!canSee(access, row, personIds))
        return json(res, 404, { error: "Документ не найден" });
      const visibleItems = (
        items: DocumentAnnotation[],
        actor: Awaited<ReturnType<typeof auth.currentUser>>,
      ) =>
        items.map((item) => ({
          ...item,
          canDelete: owns(actor, { createdBy: item.authorId }),
        }));
      if (req.method === "GET" && !annotations[2]) {
        const actor = await auth.currentUser(req);
        if (!(await accessStillCurrent(req, access)))
          return json(res, 404, { error: "Документ не найден" });
        return json(res, 200, {
          items: visibleItems(JSON.parse(row.annotations), actor),
        });
      }
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      if (!(await auth.canEdit(req)))
        return json(res, 403, { error: "Нет прав на комментарии" });
      let selection: AnnotationSelection | undefined;
      if (req.method === "POST" && !annotations[2]) {
        let body: unknown;
        try {
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            return json(res, 415, { error: "Ожидается JSON" });
          body = await readJsonBody(req, 4096);
        } catch {
          return json(res, 400, { error: "Некорректный комментарий" });
        }
        if (!validAnnotationSelection(body))
          return json(res, 400, {
            error: "Выделите фрагмент и введите комментарий",
          });
        selection = body;
      } else if (req.method !== "DELETE" || !annotations[2])
        return json(res, 405, { error: "Метод не поддерживается" });
      const result = await db.transaction(async () => {
        const current = (await db
          .prepare(
            "SELECT * FROM documents WHERE id=?",
            "SELECT * FROM documents WHERE id=?",
          )
          .get(row.id)) as Row | undefined;
        if (!current) return { status: 404, error: "Документ не найден" };
        const latest = await auth.currentUser(req);
        if (!latest?.approved || !(await auth.canEdit(req)))
          return { status: 403, error: "Нет прав на комментарии" };
        const latestAccess = await visible(req, false);
        const linked = (await associations([row.id])).get(row.id) || [];
        if (!canSee(latestAccess, current, linked))
          return { status: 404, error: "Документ не найден" };
        const items = JSON.parse(current.annotations) as DocumentAnnotation[];
        let status = 201;
        if (req.method === "POST") {
          if (!selection)
            return { status: 400, error: "Некорректный комментарий" };
          if (items.length >= 500)
            return { status: 400, error: "Достигнут лимит комментариев" };
          items.push({
            page: selection.page,
            x: selection.x,
            y: selection.y,
            width: selection.width,
            height: selection.height,
            text: selection.text.trim(),
            id: randomUUID(),
            authorId: latest.id,
            authorName: latest.name,
            createdAt: new Date().toISOString(),
          });
        } else {
          const index = items.findIndex((item) => item.id === annotations[2]);
          if (index < 0) return { status: 404, error: "Комментарий не найден" };
          if (!owns(latest, { createdBy: items[index].authorId }))
            return {
              status: 403,
              error: "Удалить комментарий может его автор или администратор",
            };
          items.splice(index, 1);
          status = 200;
        }
        await db
          .prepare(
            "UPDATE documents SET annotations=? WHERE id=?",
            "UPDATE documents SET annotations=? WHERE id=?",
          )
          .run(JSON.stringify(items), row.id);
        await audit.record(
          {
            action:
              status === 201
                ? "Добавлен комментарий к документу"
                : "Удалён комментарий к документу",
            entity: "document",
            entityId: row.id,
            label: row.title,
            personIds: linked,
            details: [],
          },
          latest,
        );
        return { status, items };
      });
      return "error" in result
        ? json(res, result.status, { error: result.error })
        : json(res, result.status, {
            items: visibleItems(result.items, await auth.currentUser(req)),
          });
    }

    if (item && req.method === "DELETE") {
      if (!(await auth.canEdit(req)))
        return json(res, 403, { error: "Нет прав на удаление документа" });
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      const result = await db.transaction(async () => {
        // Recheck access and existence after acquiring the archive write lock.
        // Another request can delete the document or revoke access while we wait.
        if (!(await auth.canEdit(req)))
          return {
            status: 403 as const,
            error: "Нет прав на удаление документа",
          };
        const row = (await db
          .prepare(
            "SELECT * FROM documents WHERE id=?",
            "SELECT * FROM documents WHERE id=?",
          )
          .get(item[1])) as Row | undefined;
        if (!row) return { status: 404 as const, error: "Документ не найден" };
        const access = await visible(req, false);
        const personIds = (await associations([row.id])).get(row.id) || [];
        if (!canSee(access, row, personIds))
          return { status: 404 as const, error: "Документ не найден" };
        const actor = await auth.currentUser(req);
        if (!owns(actor, { createdBy: row.uploaded_by }))
          return {
            status: 403 as const,
            error: "Удалить документ может его автор или администратор",
          };
        if ((await referencingPeople(row.id)).length)
          return {
            status: 409 as const,
            error: "Документ используется как источник. Сначала уберите ссылки на него из карточек и событий.",
          };
        const deleted = await db
          .prepare(
            "DELETE FROM documents WHERE id=?",
            "DELETE FROM documents WHERE id=?",
          )
          .run(row.id);
        if (deleted.changes !== 1)
          return { status: 404 as const, error: "Документ не найден" };
        await audit.record(
          {
            action: "Удалён документ",
            entity: "document",
            entityId: row.id,
            label: row.title,
            personIds,
            details: [],
          },
          actor!,
        );
        return { status: 200 as const, row };
      });
      if (result.status !== 200)
        return json(res, result.status, { error: result.error });
      const { row } = result;
      // The committed catalogue removal revokes access first. A filesystem
      // cleanup failure must not expose the file again or report a false rollback.
      if (storedDocumentFileType(row.file_name)) {
        await unlink(join(uploadsDirectory, row.file_name)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT")
              console.error("Не удалось удалить файл документа", {
                id: row.id,
                code: error.code,
              });
          },
        );
      }
      return json(res, 200, { deleted: true });
    }

    if (file && req.method === "GET") {
      const row = (await db
        .prepare(
          "SELECT * FROM documents WHERE id=?",
          "SELECT * FROM documents WHERE id=?",
        )
        .get(file[1])) as Row | undefined;
      if (!row) return json(res, 404, { error: "Документ не найден" });
      const fileType = storedDocumentFileType(row.file_name);
      if (!fileType)
        return json(res, 404, { error: "Файл документа не найден" });
      const access = await visible(req, false);
      if (
        !canSee(access, row, (await associations([row.id])).get(row.id) || [])
      )
        return json(res, 404, { error: "Документ не найден" });
      const path = join(uploadsDirectory, row.file_name);
      try {
        const info = await stat(path);
        if (!info.isFile())
          return json(res, 404, { error: "Файл документа не найден" });
        if (!(await accessStillCurrent(req, access)))
          return json(res, 404, { error: "Документ не найден" });
        const range = req.headers["if-range"]
          ? undefined
          : httpByteRange(req.headers.range, info.size);
        const headers = {
          "Content-Type": fileType.mime,
          "Content-Disposition": `inline; filename="document.${fileType.extension}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
          "Accept-Ranges": "bytes",
        };
        if (range === "unsatisfiable") {
          res
            .writeHead(416, {
              ...headers,
              "Content-Range": `bytes */${info.size}`,
              "Content-Length": "0",
            })
            .end();
          return true;
        }
        res.writeHead(range ? 206 : 200, {
          ...headers,
          "Content-Length": String(
            range ? range.end - range.start + 1 : info.size,
          ),
          ...(range
            ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` }
            : {}),
        });
        await pipeline(createReadStream(path, range), res);
      } catch (error) {
        if (!res.headersSent)
          return json(res, 404, { error: "Файл документа не найден" });
        if (!res.destroyed) res.destroy(error as Error);
      }
      return true;
    }

    if (list && req.method === "POST") {
      if (!(await auth.canEdit(req)))
        return json(res, 403, { error: "Нет прав на загрузку" });
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      const fileType = documentFileTypeFromMime(
        req.headers["content-type"]?.split(";")[0].trim() || "",
      );
      if (!fileType)
        return json(res, 415, { error: "Загрузите PDF или изображение JPEG, PNG, WebP, GIF" });
      const sizeLimitMessage = fileType.extension === "pdf"
        ? "PDF должен быть не больше 50 МБ"
        : "Изображение должно быть не больше 20 МБ";
      if (Number(req.headers["content-length"] || 0) > fileType.maxBytes)
        return json(res, 413, { error: sizeLimitMessage });
      let metadata: { title?: unknown; personIds?: unknown; eventLinks?: unknown; pages?: unknown };
      try {
        const header = String(req.headers["x-document-metadata"] || "");
        const raw = header.startsWith("base64:")
          ? Buffer.from(header.slice(7), "base64").toString("utf8")
          : decodeURIComponent(header);
        metadata = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "Некорректное описание документа" });
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        return json(res, 400, { error: "Некорректное описание документа" });
      const title =
        typeof metadata.title === "string" ? metadata.title.trim() : "";
      const ids = metadata.personIds;
      const details = parseDocumentDetails(metadata);
      const eventLinks = parseDocumentEventLinks(metadata.eventLinks ?? []);
      const pages = parseDocumentPages(metadata.pages ?? []);
      if (
        !title ||
        title.length > 160 ||
        !details ||
        !eventLinks || !pages ||
        !Array.isArray(ids) ||
        ids.length > 30 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 200) ||
        new Set(ids).size !== ids.length
      )
        return json(res, 400, { error: "Укажите название документа" });
      const access = await visible(req),
        allowed = new Set(access.ids);
      if (ids.some((id) => !allowed.has(id)))
        return json(res, 403, { error: "Нет доступа к выбранному человеку" });
      if (eventLinks.some((link) => !ids.includes(link.personId) ||
        !access.people.some((person) => person.id === link.personId &&
          person.events?.some((event) => event.id === link.eventId))))
        return json(res, 400, { error: "Свяжите событие с выбранным человеком" });

      const id = randomUUID(),
        name = `${id}.${fileType.extension}`,
        temporary = join(uploadsDirectory, `.${id}.upload`),
        target = join(uploadsDirectory, name);
      let size = 0;
      let release: (() => Promise<unknown>) | undefined;
      const header: Buffer[] = [];
      let headerSize = 0;
      try {
        const uploader = await auth.currentUser(req);
        if (!uploader?.approved || !(await auth.canEdit(req)))
          return json(res, 403, { error: "Право загрузки отозвано" });
        release = await quota.acquire(
          uploader.id,
          Number(req.headers["content-length"]) > 0
            ? Math.min(Number(req.headers["content-length"]), fileType.maxBytes)
            : fileType.maxBytes,
          async () => {
            const disk = await statfs(uploadsDirectory);
            return disk.bavail * disk.bsize;
          },
          () => media.usage(true),
        );
        const guard = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > fileType.maxBytes)
              return callback(new Error(sizeLimitMessage));
            if (headerSize < 12) {
              const part = chunk.subarray(0, 12 - headerSize);
              header.push(part);
              headerSize += part.length;
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          req,
          guard,
          createWriteStream(temporary, { flags: "wx" }),
          {
            signal: AbortSignal.timeout(120_000),
          },
        );
        const signature = Buffer.concat(header);
        if (fileType.extension === "pdf") {
          if (size < 8 || signature.toString("ascii", 0, 5) !== "%PDF-")
            return json(res, 415, { error: "Файл не является PDF" });
        } else {
          try {
            if (imageExtension(signature) !== fileType.extension)
              throw new Error("Тип файла не совпадает с содержимым");
            await sharp(await readFile(temporary), { limitInputPixels: 50_000_000 })
              .rotate()
              .resize({ width: 1, height: 1, fit: "inside" })
              .toBuffer();
          } catch {
            return json(res, 415, { error: "Файл не является поддерживаемым изображением" });
          }
        }
        await rename(temporary, target);
        const latest = await auth.currentUser(req);
        const latestPeople = (await visible(req)).people;
        const latestVisible = new Set(latestPeople.map((person) => person.id));
        if (
          !latest?.approved ||
          !(await auth.canEdit(req)) ||
          latest.id !== uploader.id ||
          ids.some((personId) => !latestVisible.has(personId as string)) ||
          eventLinks.some((link) => !latestPeople.some((person) => person.id === link.personId &&
            person.events?.some((event) => event.id === link.eventId)))
        )
          return json(res, 403, {
            error: "Доступ к выбранным людям изменился",
          });
        const committed = await db.transaction(async () => {
          const current = await auth.currentUser(req);
          const currentPeople = (await visible(req)).people;
          const currentVisible = new Set(currentPeople.map((person) => person.id));
          if (
            !current?.approved ||
            !(await auth.canEdit(req)) ||
            current.id !== uploader.id ||
            ids.some((personId) => !currentVisible.has(personId as string)) ||
            eventLinks.some((link) => !currentPeople.some((person) => person.id === link.personId &&
              person.events?.some((event) => event.id === link.eventId)))
          )
            return false;
          await db
            .prepare(
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance,event_links,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              title,
              documentSearchText(title, details),
              name,
              size,
              uploader.id,
              new Date().toISOString(),
              details.documentType,
              details.documentDate,
              details.place,
              details.description,
              details.provenance,
              JSON.stringify(eventLinks),
              JSON.stringify(pages),
            );
          const link = db.prepare(
            "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
            "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
          );
          for (const personId of ids as string[]) await link.run(id, personId);
          await enforcePostgresMediaQuota(db);
          await enforceUserStorageLimit(db, uploader.id);
          return true;
        });
        if (!committed)
          return json(res, 403, { error: "Доступ к документу изменился" });
        return json(res, 201, { id });
      } catch (error) {
        if (res.destroyed) return true;
        if (error instanceof UploadQuotaError) {
          if (error.status === 429) res.setHeader("Retry-After", "60");
          return json(res, error.status, { error: error.message });
        }
        if (size > fileType.maxBytes)
          return json(res, 413, { error: sizeLimitMessage });
        console.error("Не удалось сохранить загруженный документ", error);
        return json(res, 500, { error: "Не удалось сохранить документ" });
      } finally {
        await release?.();
        await unlink(temporary).catch(() => {});
        if (
          !(await db
            .prepare(
              "SELECT 1 FROM documents WHERE id=?",
              "SELECT 1 FROM documents WHERE id=?",
            )
            .get(id))
        )
          await unlink(target).catch(() => {});
      }
    }
    return json(res, 405, { error: "Метод не поддерживается" });
  };
}
