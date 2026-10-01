import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import {
  offlineDocuments,
  offlineFamily,
  writeOfflinePackage,
  type OfflineScope,
} from "./offline-package.ts";
import { createSharedRequestLimiter } from "./shared-request-rate-limit.ts";

const scopes = new Set<OfflineScope>([
  "all",
  "family",
  "ancestors",
  "descendants",
  "blood",
]);

export function offlinePackageHttp({
  archive,
  auth,
  uploadsDirectory,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  uploadsDirectory: string;
}) {
  const limiter = createSharedRequestLimiter(archive.db, "offline-export", { windowMs: 300_000, limit: 3 });
  const active = new Set<string>();
  const readDocumentIndex = async () => {
    const rows = (await archive.db
      .prepare(
        "SELECT id,title,file_name,created_at,document_type,document_date,place,description,provenance,event_links,pages FROM documents ORDER BY id",
        "SELECT id,title,file_name,created_at,document_type,document_date,place,description,provenance,event_links,pages FROM documents ORDER BY id",
      )
      .all()) as Array<{
      id: string;
      title: string;
      file_name: string;
      created_at: string;
      document_type: string;
      document_date: string;
      place: string;
      description: string;
      provenance: string;
      event_links: string;
      pages: string;
    }>;
    const links = (await archive.db
      .prepare(
        "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id",
        "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id",
      )
      .all()) as Array<{ document_id: string; person_id: string }>;
    return { rows, links };
  };
  const json = (res: ServerResponse, status: number, error: string) => {
    if (res.destroyed) return true;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    });
    res.end(JSON.stringify({ error }));
    return true;
  };
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/api/offline/export") return false;
    if (req.method !== "GET") return json(res, 405, "Ожидается GET");
    const actor = await auth.currentUser(req);
    if (!actor || !(await auth.canRead(req)))
      return json(res, 401, "Войдите, чтобы скачать офлайн-пакет");
    const requestedScope = url.searchParams.get("scope") || "all";
    if (!scopes.has(requestedScope as OfflineScope))
      return json(res, 400, "Неизвестная область экспорта");
    const scope = requestedScope as OfflineScope;
    const anchor = url.searchParams.get("anchor") || undefined;
    const generations = Number(url.searchParams.get("generations") || 5);
    if (
      (scope !== "all" && (!anchor || anchor.length > 200)) ||
      !Number.isInteger(generations) ||
      generations < 1 ||
      generations > 20
    )
      return json(res, 400, "Некорректные параметры ветки");
    if (!(await limiter.allow(actor.id))) {
      res.setHeader("Retry-After", "300");
      return json(res, 429, "Слишком много запросов экспорта");
    }
    if (active.has(actor.id) || active.size >= 1)
      return json(res, 429, "Экспорт уже выполняется. Дождитесь завершения.");

    const performExport = async () => {
      active.add(actor.id);
      let directory = "";
      try {
        directory = await mkdtemp(join(tmpdir(), "drevo-offline-"));
        const snapshot = await archive.read();
        const visible = projectFamilyForUser(snapshot.family, actor);
        if (
          scope !== "all" &&
          !visible.people.some((person) => person.id === anchor)
        )
          return json(res, 404, "Выбранный человек недоступен");
        const family = offlineFamily(visible, scope, anchor, generations);
        const { rows, links } = await readDocumentIndex();
        const documents = offlineDocuments(
          rows,
          links,
          family,
          scope === "all" && !isScopedUser(actor),
        );
        const path = join(directory, "archive.zip");
        await writeOfflinePackage(
          path,
          uploadsDirectory,
          family,
          documents,
          snapshot.revision,
          scope,
        );
        const current = await auth.currentUser(req);
        const currentIndex = await readDocumentIndex();
        if (
          !current ||
          !(await auth.canRead(req)) ||
          current.id !== actor.id ||
          current.role !== actor.role ||
          current.personId !== actor.personId ||
          current.treeAccess !== actor.treeAccess ||
          (await archive.meta()).revision !== snapshot.revision ||
          JSON.stringify(currentIndex.rows) !== JSON.stringify(rows) ||
          JSON.stringify(currentIndex.links) !== JSON.stringify(links)
        )
          return json(
            res,
            409,
            "Архив или права изменились во время экспорта. Повторите скачивание.",
          );
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": String((await stat(path)).size),
          "Content-Disposition": 'attachment; filename="drevo-offline.zip"',
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        await pipeline(createReadStream(path), res);
        return true;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "offline_export_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (res.headersSent) {
          res.destroy(error as Error);
          return true;
        }
        const tooLarge =
          error instanceof Error &&
          error.message.startsWith("Офлайн-пакет превышает 1 ГБ");
        return json(
          res,
          tooLarge ? 413 : 500,
          tooLarge
            ? "Офлайн-пакет превышает 1 ГБ; выберите меньшую ветку."
            : "Не удалось создать офлайн-пакет. Проверьте доступность оригиналов файлов и повторите попытку.",
        );
      } finally {
        active.delete(actor.id);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    };
    if (!archive.db.withExclusiveArchiveTask) return await performExport();
    const task = await archive.db.withExclusiveArchiveTask(
      "offline-export", performExport,
    );
    return task.acquired
      ? task.value
      : json(res, 429, "Экспорт уже выполняется. Дождитесь завершения.");
  };
}
