import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PoolClient } from "pg";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import {
  detachUnavailableCitationDocuments,
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
const deliveryDeadlineMs = 5 * 60_000;

export function offlinePackageHttp({
  archive,
  auth,
  uploadsDirectory,
  streamDeadlineMs = deliveryDeadlineMs,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  uploadsDirectory: string;
  streamDeadlineMs?: number;
}) {
  const limiter = createSharedRequestLimiter(archive.db, "offline-export", { windowMs: 300_000, limit: 3 });
  const active = new Set<string>();
  const documentIndexSql = "SELECT id,title,file_name,uploaded_by,created_at,document_type,document_date,place,description,provenance,event_links,pages FROM documents ORDER BY id";
  const documentLinksSql = "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id";
  type DocumentRow = {
    id: string;
    title: string;
    file_name: string;
    uploaded_by: string;
    created_at: string;
    document_type: string;
    document_date: string;
    place: string;
    description: string;
    provenance: string;
    event_links: string;
    pages: string;
  };
  type DocumentLink = { document_id: string; person_id: string };
  const readDocumentIndex = async (client?: PoolClient) => {
    const rows = client
      ? (await client.query(documentIndexSql)).rows as DocumentRow[]
      : (await archive.db.prepare(documentIndexSql, documentIndexSql).all()) as DocumentRow[];
    const links = client
      ? (await client.query(documentLinksSql)).rows as DocumentLink[]
      : (await archive.db.prepare(documentLinksSql, documentLinksSql).all()) as DocumentLink[];
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
          { canReadAll: !isScopedUser(actor), userId: actor.id },
        );
        const omittedDocument = detachUnavailableCitationDocuments(family, documents);
        const path = join(directory, "archive.zip");
        await writeOfflinePackage(
          path,
          uploadsDirectory,
          family,
          documents,
          snapshot.revision,
          scope,
          omittedDocument ? ["Некоторые вложенные документы цитат недоступны для этого экспорта; текст цитат сохранён."] : [],
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
        const packageSize = (await stat(path)).size;
        const sendZip = async () => {
          if (res.destroyed) return;
          const deadline = setTimeout(() =>
            res.destroy(new Error("Offline ZIP delivery timed out")), streamDeadlineMs);
          deadline.unref();
          try {
            res.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Length": String(packageSize),
              "Content-Disposition": 'attachment; filename="drevo-offline.zip"',
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            });
            await pipeline(createReadStream(path), res);
          } finally {
            clearTimeout(deadline);
          }
        };
        if (archive.db.kind !== "postgres" || auth.local || !archive.db.postgresTransaction) {
          await sendZip();
          return true;
        }
        const session = await auth.accountSession(req);
        if (!session || session.accountId !== actor.id)
          return json(res, 401, "Сессия завершена. Войдите снова");
        let delivery: "sent" | "changed" | "expired";
        try {
          delivery = await archive.db.postgresTransaction(async (client) => {
            // Hold only access rows through delivery. The finished ZIP is a
            // snapshot; locking the archive would block normal edits for the
            // duration of a slow download.
            const lockedSession = await client.query<{ expires_at: string }>(
              `SELECT expires_at FROM account_sessions
               WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [session.tokenHash, actor.id],
            );
            if (!lockedSession.rows[0] || Number(lockedSession.rows[0].expires_at) <= Date.now())
              return "expired";
            const membership = await client.query<{
              role: string; approved: boolean; person_id: string | null; tree_access: string;
            }>(
              `SELECT role,approved,person_id,tree_access FROM archive_memberships
               WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [archive.db.archiveId, actor.id],
            );
            const row = membership.rows[0];
            if (!row || !row.approved || row.role !== actor.role ||
                (row.person_id || "") !== (actor.personId || "") ||
                row.tree_access !== (actor.treeAccess || "all"))
              return "changed";
            const currentArchive = await client.query<{ revision: number }>(
              "SELECT revision FROM archives WHERE id=$1",
              [archive.db.archiveId],
            );
            if (Number(currentArchive.rows[0]?.revision) !== snapshot.revision)
              return "changed";
            const finalIndex = await readDocumentIndex(client);
            if (JSON.stringify(finalIndex.rows) !== JSON.stringify(rows) ||
                JSON.stringify(finalIndex.links) !== JSON.stringify(links))
              return "changed";
            await sendZip();
            return "sent";
          });
        } catch (error) {
          if ((error as { code?: string }).code === "55P03")
            return json(res, 409, "Архив или сеанс заняты другим действием. Повторите скачивание");
          throw error;
        }
        if (delivery === "expired")
          return json(res, 401, "Сессия завершена. Войдите снова");
        if (delivery === "changed")
          return json(res, 409, "Архив или права изменились во время экспорта. Повторите скачивание");
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
