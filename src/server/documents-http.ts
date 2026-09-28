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
import { auditStore } from "./audit.ts";
import {
  documentUploadQuota,
  UploadQuotaError,
} from "./document-upload-quota.ts";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
type Row = {
  id: string;
  title: string;
  file_name: string;
  file_size: number;
  created_at: string;
  uploaded_by: string;
};

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
  const quota = documentUploadQuota(db);
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
    if (!list && !file && !item) return false;
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
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          size: row.file_size,
          createdAt: row.created_at,
          canDelete: mayEdit && owns(actor, { createdBy: row.uploaded_by }),
          url: `/api/documents/${row.id}/file`,
          people: (links.get(row.id) || [])
            .filter((id) => people.has(id))
            .map((id) => ({ id, name: people.get(id) })),
        })),
      });
    }

    if (item && req.method === "DELETE") {
      if (!(await auth.canEdit(req)))
        return json(res, 403, { error: "Нет прав на удаление документа" });
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      const row = (await db
        .prepare(
          "SELECT * FROM documents WHERE id=?",
          "SELECT * FROM documents WHERE id=?",
        )
        .get(item[1])) as Row | undefined;
      const access = await visible(req);
      const personIds = row
        ? (await associations([row.id])).get(row.id) || []
        : [];
      if (
        !row ||
        (access.scoped && !personIds.some((id) => access.ids.includes(id)))
      )
        return json(res, 404, { error: "Документ не найден" });
      const actor = await auth.currentUser(req);
      if (!owns(actor, { createdBy: row.uploaded_by }))
        return json(res, 403, {
          error: "Удалить документ может его автор или администратор",
        });
      await db.transaction(async () => {
        await db
          .prepare(
            "DELETE FROM documents WHERE id=?",
            "DELETE FROM documents WHERE id=?",
          )
          .run(row.id);
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
      });
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
