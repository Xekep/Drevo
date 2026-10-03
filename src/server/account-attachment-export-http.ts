import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { accountDataExport } from "./account-data-export.ts";
import {
  AccountAttachmentExportMissing,
  AccountAttachmentExportTooLarge,
  ownAttachmentsStillCurrent,
  prepareAccountAttachmentExport,
  type OwnCommentAttachment,
} from "./account-attachment-export.ts";

/** Personal discussion originals are separate from the versioned account JSON.
 * A reader may download only files on comments they authored and can still see. */
export function accountAttachmentExportHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  uploadsForArchive: (archiveId: string) => string,
  beforeSend?: () => Promise<void>,
) {
  const exporter = accountDataExport(db);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/export/attachments") return false;
    const send = (status: number, error: string) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(JSON.stringify({ error }));
      return true;
    };
    if (req.method !== "GET") return send(405, "Метод не поддерживается");
    if (db.kind !== "postgres") return send(404, "Экспорт аккаунта здесь недоступен");
    const session = await auth.accountSession(req);
    if (!session) return send(401, "Требуется вход в аккаунт");
    // Skip AI history: its size and entitlement are unrelated to discussion
    // originals, and the attachment bundle has its own streaming limit.
    const prepared = await exporter.read(session.accountId, false);
    if (!prepared) return send(404, "Аккаунт не найден");
    const readable = prepared.download.archives.filter((archive) => archive.approved);
    if (!readable.length) return send(403, "Нет доступа к обсуждениям архивов");
    const own: OwnCommentAttachment[] = readable.flatMap((archive) =>
      (archive.ownComments || []).flatMap((comment) =>
        comment.attachments.map((file) => ({
          archiveId: archive.id,
          personId: comment.personId,
          commentId: comment.id,
          file,
        }))));
    let bundle;
    try {
      bundle = await prepareAccountAttachmentExport(own, uploadsForArchive);
    } catch (error) {
      if (error instanceof AccountAttachmentExportTooLarge)
        return send(413, "Вложения слишком велики для одной выгрузки");
      if (error instanceof AccountAttachmentExportMissing)
        return send(409, "Оригинал вложения недоступен. Повторите экспорт после восстановления файла");
      throw error;
    }
    await beforeSend?.();
    const delivery = await exporter.deliverWithCurrentSession(
      session.accountId,
      session.tokenHash,
      prepared.accessScopes,
      async () => {
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="drevo-account-attachments.zip"',
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        await bundle.writeTo(res);
      },
      (client) => ownAttachmentsStillCurrent(client, session.accountId, own),
    );
    if (delivery === "session-expired") return send(401, "Сеанс завершён. Войдите снова");
    if (delivery === "access-changed") return send(409, "Доступ к дереву изменился. Повторите экспорт");
    if (delivery === "access-busy") return send(409, "Права доступа меняются. Повторите экспорт");
    return true;
  };
}
