import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { rename, stat, statfs, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import type { mediaStore } from "./media.ts";
import { fullName } from "../domain/index.ts";
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

const MAX_PDF_BYTES = 20 * 1024 * 1024;
async function readAnnotationBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error("Комментарий слишком длинный");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type Row = {
  id: string;
  title: string;
  file_name: string;
  file_size: number;
  created_at: string;
  uploaded_by: string;
  annotations: string;
};

function listedDocument(
  row: Row,
  linkedIds: string[],
  people: Map<string, string>,
  canDelete: boolean,
) {
  return {
    id: row.id,
    title: row.title,
    size: row.file_size,
    createdAt: row.created_at,
    canDelete,
    url: `/api/documents/${row.id}/file`,
    people: linkedIds
      .filter((id) => people.has(id))
      .map((id) => ({ id, name: people.get(id)! })),
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
  const visible = async (req: IncomingMessage) => {
    const user = await auth.currentUser(req);
    const family = isScopedUser(user)
      ? projectFamilyForUser((await archive.read()).family, user)
      : (await archive.read()).family;
    return {
      scoped: isScopedUser(user),
      people: family.people,
      ids: family.people.map((person) => person.id),
    };
  };
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
      const access = await visible(req);
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
            ? "EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)))"
            : "EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM json_each(?)))",
        );
        args.push(JSON.stringify(access.ids));
      }
      if (query) {
        const peopleIds = access.people
          .filter((person) =>
            fullName(person).toLocaleLowerCase("ru").includes(query),
          )
          .map((person) => person.id);
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
      const people = new Map(
        access.people.map((person) => [person.id, fullName(person)]),
      );
      const actor = await auth.currentUser(req),
        mayEdit = await auth.canEdit(req);
      return json(res, 200, {
        total,
        items: rows.map((row) =>
          listedDocument(
            row,
            links.get(row.id) || [],
            people,
            mayEdit && owns(actor, { createdBy: row.uploaded_by }),
          ),
        ),
      });
    }

    if (item && req.method === "GET") {
      const row = (await db
        .prepare("SELECT * FROM documents WHERE id=?")
        .get(item[1])) as Row | undefined;
      if (!row) return json(res, 404, { error: "Документ не найден" });
      const access = await visible(req);
      const linkedIds = (await associations([row.id])).get(row.id) || [];
      if (access.scoped && !linkedIds.some((id) => access.ids.includes(id)))
        return json(res, 404, { error: "Документ не найден" });
      const people = new Map(
        access.people.map((person) => [person.id, fullName(person)]),
      );
      return json(
        res,
        200,
        listedDocument(
          row,
          linkedIds,
          people,
          (await auth.canEdit(req)) &&
            owns(await auth.currentUser(req), { createdBy: row.uploaded_by }),
        ),
      );
    }

    if (annotations) {
      const row = (await db
        .prepare(
          "SELECT * FROM documents WHERE id=?",
          "SELECT * FROM documents WHERE id=?",
        )
        .get(annotations[1])) as Row | undefined;
      if (!row) return json(res, 404, { error: "Документ не найден" });
      const access = await visible(req);
      const personIds = (await associations([row.id])).get(row.id) || [];
      if (access.scoped && !personIds.some((id) => access.ids.includes(id)))
        return json(res, 404, { error: "Документ не найден" });
      const visibleItems = (
        items: DocumentAnnotation[],
        actor: Awaited<ReturnType<typeof auth.currentUser>>,
      ) =>
        items.map((item) => ({
          ...item,
          canDelete: owns(actor, { createdBy: item.authorId }),
        }));
      if (req.method === "GET" && !annotations[2])
        return json(res, 200, {
          items: visibleItems(
            JSON.parse(row.annotations),
            await auth.currentUser(req),
          ),
        });
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
          body = await readAnnotationBody(req);
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
        const allowed = new Set((await visible(req)).ids);
        const linked = (await associations([row.id])).get(row.id) || [];
        if (isScopedUser(latest) && !linked.some((id) => allowed.has(id)))
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
        const access = await visible(req);
        const personIds = (await associations([row.id])).get(row.id) || [];
        if (access.scoped && !personIds.some((id) => access.ids.includes(id)))
          return { status: 404 as const, error: "Документ не найден" };
        const actor = await auth.currentUser(req);
        if (!owns(actor, { createdBy: row.uploaded_by }))
          return {
            status: 403 as const,
            error: "Удалить документ может его автор или администратор",
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
      if (/^[a-f0-9-]{36}\.pdf$/.test(row.file_name)) {
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
      if (!/^[a-f0-9-]{36}\.pdf$/.test(row.file_name))
        return json(res, 404, { error: "Файл документа не найден" });
      const access = await visible(req);
      if (
        access.scoped &&
        !(await db
          .prepare(
            "SELECT 1 FROM document_people WHERE document_id=? AND person_id IN (SELECT value FROM json_each(?)) LIMIT 1",
            "SELECT 1 FROM document_people WHERE document_id=? AND person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) LIMIT 1",
          )
          .get(row.id, JSON.stringify(access.ids)))
      )
        return json(res, 404, { error: "Документ не найден" });
      const path = join(uploadsDirectory, row.file_name);
      try {
        const info = await stat(path);
        if (!info.isFile())
          return json(res, 404, { error: "Файл документа не найден" });
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Length": String(info.size),
          "Content-Disposition": 'inline; filename="document.pdf"',
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        });
        await pipeline(createReadStream(path), res);
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
      if (
        req.headers["content-type"]?.split(";")[0].trim() !== "application/pdf"
      )
        return json(res, 415, { error: "Загрузите PDF-файл" });
      if (Number(req.headers["content-length"] || 0) > MAX_PDF_BYTES)
        return json(res, 413, { error: "PDF должен быть не больше 20 МБ" });
      let metadata: { title?: unknown; personIds?: unknown };
      try {
        metadata = JSON.parse(
          decodeURIComponent(String(req.headers["x-document-metadata"] || "")),
        );
      } catch {
        return json(res, 400, { error: "Некорректное описание документа" });
      }
      const title =
        typeof metadata.title === "string" ? metadata.title.trim() : "";
      const ids = metadata.personIds;
      if (
        !title ||
        title.length > 160 ||
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 30 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 200) ||
        new Set(ids).size !== ids.length
      )
        return json(res, 400, { error: "Укажите название и связанных людей" });
      const access = await visible(req),
        allowed = new Set(access.ids);
      if (ids.some((id) => !allowed.has(id)))
        return json(res, 403, { error: "Нет доступа к выбранному человеку" });

      const id = randomUUID(),
        name = `${id}.pdf`,
        temporary = join(uploadsDirectory, `.${id}.upload`),
        target = join(uploadsDirectory, name);
      let size = 0;
      let release: (() => unknown) | undefined;
      const header: Buffer[] = [];
      let headerSize = 0;
      try {
        const images = await media.usage();
        const disk = await statfs(uploadsDirectory);
        const uploader = await auth.currentUser(req);
        if (!uploader?.approved || !(await auth.canEdit(req)))
          return json(res, 403, { error: "Право загрузки отозвано" });
        release = await quota.acquire(
          uploader.id,
          MAX_PDF_BYTES,
          disk.bavail * disk.bsize,
          images,
        );
        const guard = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_PDF_BYTES)
              return callback(new Error("PDF должен быть не больше 20 МБ"));
            if (headerSize < 5) {
              const part = chunk.subarray(0, 5 - headerSize);
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
        if (size < 8 || Buffer.concat(header).toString("ascii") !== "%PDF-") {
          await unlink(temporary);
          return json(res, 415, { error: "Файл не является PDF" });
        }
        await rename(temporary, target);
        const latest = await auth.currentUser(req);
        const latestVisible = new Set((await visible(req)).ids);
        if (
          !latest?.approved ||
          !(await auth.canEdit(req)) ||
          latest.id !== uploader.id ||
          ids.some((personId) => !latestVisible.has(personId as string))
        )
          return json(res, 403, {
            error: "Доступ к выбранным людям изменился",
          });
        await db.transaction(async () => {
          await db
            .prepare(
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
              "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              id,
              title,
              title.toLocaleLowerCase("ru"),
              name,
              size,
              uploader.id,
              new Date().toISOString(),
            );
          const link = db.prepare(
            "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
            "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
          );
          for (const personId of ids as string[]) await link.run(id, personId);
          await enforcePostgresMediaQuota(db);
        });
        return json(res, 201, { id });
      } catch (error) {
        if (res.destroyed) return true;
        if (error instanceof UploadQuotaError) {
          if (error.status === 429) res.setHeader("Retry-After", "60");
          return json(res, error.status, { error: error.message });
        }
        if (size > MAX_PDF_BYTES)
          return json(res, 413, { error: "PDF должен быть не больше 20 МБ" });
        console.error("Не удалось сохранить загруженный PDF", error);
        return json(res, 500, { error: "Не удалось сохранить PDF" });
      } finally {
        release?.();
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
