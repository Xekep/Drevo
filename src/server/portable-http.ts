import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { readArchive, type openArchive } from "./database.ts";
import { ForbiddenError } from "./users.ts";
import { sourceCatalogStore } from "./source-catalog-store.ts";
import {
  writePortablePackage,
  PortablePackageError,
  type PortableComment,
  type PortableDocument,
  type PortableSnapshot,
} from "./portable-package.ts";

export function portableExportHttp(
  archive: Awaited<ReturnType<typeof openArchive>>,
  auth: Awaited<ReturnType<typeof createAuth>>,
  uploads: string,
) {
  const db = archive.db;
  let exporting = false;
  const owner =
    db.kind === "postgres"
      ? db.prepare("", "SELECT 1 FROM archive_owners WHERE user_id=?")
      : null;

  async function mayExport(req: IncomingMessage) {
    const actor = await auth.currentUser(req);
    if (!actor || actor.role !== "admin") return false;
    return auth.local || !!(await owner?.get(actor.id));
  }

  async function snapshot(): Promise<PortableSnapshot> {
    return db.transaction(async () => {
      const family = (await readArchive(db)).family;
      const rows = await db
        .prepare(
          "SELECT id,title,file_name,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages FROM documents ORDER BY id",
          "SELECT id,title,file_name,uploaded_by,created_at,document_type,document_date,place,description,provenance,annotations,event_links,pages FROM documents ORDER BY id",
        )
        .all();
      const links = await db
        .prepare(
          "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id",
          "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id",
        )
        .all();
      const peopleByDocument = new Map<string, string[]>();
      for (const link of links) {
        const id = String(link.document_id);
        const people = peopleByDocument.get(id) || [];
        people.push(String(link.person_id));
        peopleByDocument.set(id, people);
      }
      const documents: PortableDocument[] = rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        fileName: String(row.file_name),
        uploadedBy: String(row.uploaded_by),
        createdAt: String(row.created_at),
        documentType: String(row.document_type || ""),
        documentDate: String(row.document_date || ""),
        place: String(row.place || ""),
        description: String(row.description || ""),
        provenance: String(row.provenance || ""),
        annotations: JSON.parse(String(row.annotations || "[]")),
        personIds: peopleByDocument.get(String(row.id)) || [],
        eventLinks: JSON.parse(String(row.event_links || "[]")),
        pages: JSON.parse(String(row.pages || "[]")),
      }));
      const commentRows = await db
        .prepare(
          `SELECT c.id,c.person_id,c.author_id,COALESCE(NULLIF(c.author_name,''),u.name,'') AS author_name,c.created_ms,c.text
         FROM person_comments c LEFT JOIN users u ON u.id=c.author_id ORDER BY c.id`,
          `SELECT c.id,c.person_id,c.author_id,COALESCE(NULLIF(c.author_name,''),u.name,'') AS author_name,c.created_ms,c.text
         FROM runtime_visible_person_comments c LEFT JOIN runtime_users u ON u.id=c.author_id ORDER BY c.id`,
        )
        .all();
      const comments: PortableComment[] = commentRows.map((row) => ({
        id: Number(row.id),
        personId: String(row.person_id),
        authorId: String(row.author_id),
        authorName: String(row.author_name || ""),
        createdMs: Number(row.created_ms),
        text: String(row.text),
      }));
      const sources = (await sourceCatalogStore(db).list()).map((entry) => {
        const source = { ...entry };
        delete (source as Partial<typeof source>).version;
        return source;
      });
      return { family, documents, comments, sources };
    }, true);
  }

  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/drevo/export") return false;
    const json = (status: number, error: string) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error }));
      return true;
    };
    if (req.method !== "GET") return json(405, "Ожидается GET");
    if (!(await mayExport(req)))
      return json(
        (await auth.currentUser(req)) ? 403 : 401,
        "Экспорт доступен владельцу дерева",
    );
    if (exporting) return json(429, "Другой экспорт уже выполняется");
    const performExport = async () => {
      exporting = true;
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.once("close", onClose);
      try {
        const data = await snapshot();
        await writePortablePackage(
          res,
          uploads,
          data,
          async () => {
            if (!(await mayExport(req)))
              throw new ForbiddenError("Доступ владельца отозван");
            res.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Disposition": 'attachment; filename="drevo.drevo"',
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
          },
          controller.signal,
        );
        return true;
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.destroy(error as Error);
          return true;
        }
        if (error instanceof ForbiddenError) return json(403, error.message);
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return json(409, "Один из оригиналов архива недоступен");
        if (error instanceof PortablePackageError)
          return json(409, error.message);
        throw error;
      } finally {
        res.off("close", onClose);
        exporting = false;
      }
    };
    if (!db.withExclusiveArchiveTask) return await performExport();
    const task = await db.withExclusiveArchiveTask(
      "portable-export", performExport,
    );
    return task.acquired
      ? task.value
      : json(429, "Другой экспорт уже выполняется");
  };
}
