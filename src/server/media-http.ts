import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import { ImagePreviewBusyError, type imagePreviews, type ImagePreviewVariant } from "./image-previews.ts";
import type { mediaStore } from "./media.ts";
import type { settingsStore } from "./settings.ts";
import type { openArchive } from "./database.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { ownsPendingMedia } from "./media-access.ts";
import { allCitations } from "./source-catalog-store.ts";
import type { Family } from "../domain/types.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { pdfDocumentPages } from "./document-pdf.ts";
import { assertMemberPreviewDelivery, memberPreviewTarget } from "./member-preview-access.ts";

type MediaAccess = "public" | { user: ArchiveUser; pending: boolean };

function citationUrls(family: Family) {
  return allCitations(family).flatMap((citation) => {
    const url = citation.url?.split(/[?#]/, 1)[0];
    return url?.startsWith("/media/") ? [url] : [];
  });
}

export function mediaHttp({
  auth,
  media,
  previewImage,
  visibility,
  archive,
  beforeDelivery,
  beforeLockedDelivery,
  pdfPages,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  archive: Awaited<ReturnType<typeof openArchive>>;
  /** Test seam for a permission change after the last reference read. */
  beforeDelivery?: () => Promise<void>;
  /** Test seam for a concurrent edit while final rows are locked. */
  beforeLockedDelivery?: () => Promise<void>;
  pdfPages?: ReturnType<typeof pdfDocumentPages>;
}) {
  let cachedKey = "",
    cachedUrls = new Set<string>();
  const referenced = async (url: string, albums: boolean, portraits: boolean) => {
    if (albums &&
      await archive.db
        .prepare(
          "SELECT 1 FROM photos WHERE json_extract(data,'$.url')=? LIMIT 1",
          "SELECT 1 FROM photos WHERE (data->>'url')=? LIMIT 1",
        )
        .get(url)
    )
      return true;
    return (
      portraits &&
      !!(await archive.db
        .prepare(
          "SELECT 1 FROM people WHERE json_extract(data,'$.photo')=? LIMIT 1",
          "SELECT 1 FROM people WHERE (data->>'photo')=? LIMIT 1",
        )
        .get(url))
    );
  };
  const permitted = async (req: IncomingMessage, url?: string): Promise<MediaAccess | null> => {
    const canRead = await auth.canRead(req);
    const publicAccess = canRead ? null : await visibility.read();
    if (!canRead && !publicAccess?.publicTree && !publicAccess?.publicAlbums) return null;
    if (!url) return null;
    if (!canRead) {
      // Public albums expose only regular gallery images, never originals
      // attached solely as archive evidence.
      if (!media.open(url)) return null;
      // UUID is an identifier, not permission to view an unpublished upload.
      return await referenced(url, !!publicAccess?.publicAlbums,
        !!publicAccess?.publicTree) ? "public" : null;
    }
    const user = await auth.currentUser(req);
    if (!user?.approved) return null;
    if (await ownsPendingMedia(archive.db, url, user.id))
      return { user, pending: true };
    if (!isScopedUser(user))
      return (await referenced(url, true, true) ||
        citationUrls((await archive.read()).family).includes(url))
        ? { user, pending: false } : null;
    const key = `${(await archive.meta()).revision}:${user.id}:${user.personId || ""}:${user.treeAccess || "all"}`;
    if (key !== cachedKey) {
      const scoped = projectFamilyForUser((await archive.read()).family, user);
      cachedUrls = new Set([
        ...scoped.people
          .map((person) => person.photo)
          .filter((photo): photo is string => !!photo),
        ...(scoped.photos || []).map((photo) => photo.url),
      ]);
      cachedKey = key;
    }
    if (cachedUrls.has(url)) return { user, pending: false };
    // Citation edits may happen through the source catalogue without changing
    // the tree revision. Re-evaluate visibility instead of caching a grant.
    return citationUrls(projectFamilyForUser((await archive.read()).family, user))
      .includes(url) ? { user, pending: false } : null;
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const denied = (res: ServerResponse) =>
    json(res, 401, { error: "Доступ к фотографиям закрыт" });
  const deliver = async (
    req: IncomingMessage,
    res: ServerResponse,
    access: MediaAccess,
    url: string,
    expectedRevision: number,
    start: () => void,
    complete: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (beforeDelivery) await beforeDelivery();
    if (!auth.local && archive.db.kind === "postgres") {
      const actor = access === "public" ? null : access.user;
      const preview = memberPreviewTarget(req);
      const previewUser = preview ? await auth.currentUser(req) : null;
      const session = actor || preview ? await auth.accountSession(req) : null;
      if (preview && (!previewUser || previewUser.id !== preview)) return denied(res);
      if ((actor || preview) && (!session || (!preview && session.accountId !== actor?.id)))
        return denied(res);
      if (!archive.db.postgresTransaction || !archive.db.archiveId)
        throw new Error("PostgreSQL media delivery requires an archive transaction");
      try {
        let changed = false;
        const valid = await archive.db.postgresTransaction(async (client) => {
          let previewExpiresAt: number | null = null;
          // Family and source-catalog writes both bump archive revision.
          // Hold the archive/session/member rows only until the first write.
          // A long original continues as an already-authorized HTTP request.
          const archived = await client.query<{ revision: string }>(
            "SELECT revision FROM archives WHERE id=$1 FOR SHARE NOWAIT", [archive.db.archiveId]);
          if (!archived.rows[0]) return false;
          if (Number(archived.rows[0].revision) !== expectedRevision) {
            changed = true;
            return false;
          }
          if (preview) {
            if (!session || !previewUser) return false;
            previewExpiresAt = await assertMemberPreviewDelivery(client,
              archive.db.archiveId!, session, actor || previewUser);
            if (!previewExpiresAt) return false;
          }
          if (!actor) {
            const visible = await client.query<{ public_tree: boolean; public_albums: boolean }>(
              `SELECT public_tree,public_albums FROM archive_access_settings
               WHERE archive_id=$1 FOR SHARE NOWAIT`, [archive.db.archiveId]);
            if (!visible.rows[0]?.public_tree && !visible.rows[0]?.public_albums) return false;
            const reference = await client.query<{ allowed: boolean }>(
              `SELECT (($3::boolean AND EXISTS(SELECT 1 FROM photos
                WHERE archive_id=$1 AND data->>'url'=$2)) OR
                ($4::boolean AND EXISTS(SELECT 1 FROM people
                WHERE archive_id=$1 AND data->>'photo'=$2))) AS allowed`,
              [archive.db.archiveId, url, visible.rows[0].public_albums,
                visible.rows[0].public_tree],
            );
            if (!reference.rows[0]?.allowed) return false;
          } else if (!preview) {
            const active = await client.query<{ expires_at: string }>(
              `SELECT expires_at FROM account_sessions
               WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [session!.tokenHash, actor.id],
            );
            if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now()) return false;
            const member = await client.query<{
              role: string; approved: boolean; person_id: string | null; tree_access: string;
            }>(`SELECT role,approved,person_id,tree_access FROM archive_memberships
                WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [archive.db.archiveId, actor.id]);
            const current = member.rows[0];
            if (!current?.approved || current.role !== actor.role ||
                (current.person_id || "") !== (actor.personId || "") ||
                current.tree_access !== (actor.treeAccess || "all")) return false;
            if (access !== "public" && access.pending) {
              const grant = await client.query<{ expires_ms: string }>(
                `SELECT expires_ms FROM media_upload_grants
                 WHERE archive_id=$1 AND url=$2 AND user_id=$3 FOR SHARE NOWAIT`,
                [archive.db.archiveId, url, actor.id],
              );
              if (!grant.rows[0] || Number(grant.rows[0].expires_ms) <= Date.now())
                return false;
            }
          }
          if (preview && actor && access !== "public" && access.pending) {
            const grant = await client.query<{ expires_ms: string }>(
              `SELECT expires_ms FROM media_upload_grants
               WHERE archive_id=$1 AND url=$2 AND user_id=$3 FOR SHARE NOWAIT`,
              [archive.db.archiveId, url, actor.id],
            );
            if (!grant.rows[0] || Number(grant.rows[0].expires_ms) <= Date.now())
              return false;
          }
          if (beforeLockedDelivery) await beforeLockedDelivery();
          if (previewExpiresAt && Date.now() >= previewExpiresAt) return false;
          start();
          return true;
        });
        if (!valid) return changed
          ? json(res, 409, { error: "Архив изменился. Повторите запрос." })
          : denied(res);
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.destroy();
          return true;
        }
        if ((error as { code?: string }).code === "55P03")
          return json(res, 503, { error: "Повторите запрос позже" });
        throw error;
      }
    } else start();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      res.destroy();
    }, 60_000);
    timeout.unref();
    try {
      await complete(controller.signal);
    } catch {
      if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timeout);
    }
    return true;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/media/") || req.method !== "GET")
      return false;
    if (!(await permitted(req, url.pathname)))
      return json(res, 401, { error: "Sign in to view this archive" });

    const file = media.openOriginal(url.pathname);
    if (!file) return json(res, 404, { error: "Фото не найдено" });
    if (file.type === "application/pdf" && url.searchParams.get("reader") === "pages" && pdfPages) {
      const pages = await pdfPages(file.path);
      const expectedRevision = (await archive.meta()).revision;
      const access = await permitted(req, url.pathname);
      if (!access) return denied(res);
      let delivered!: Promise<void>;
      return await deliver(req, res, access, url.pathname, expectedRevision,
        () => { delivered = finished(res, { cleanup: true }).catch(() => {}); json(res, 200, { pages }); },
        async () => { await delivered; });
    }
    const requested = url.searchParams.get("variant");
    const variant: ImagePreviewVariant | null =
      requested === "tiny" || requested === "avatar" || requested === "thumb" || requested === "display"
        ? requested : null;

    if (variant && media.open(url.pathname) && file.type !== "image/gif") {
      let bytes: Buffer | undefined;
      try {
        bytes = await previewImage(
          { path: file.path, cacheKey: file.name },
          variant,
        );
      } catch (error) {
        if (error instanceof ImagePreviewBusyError) {
          res.writeHead(503, { "Cache-Control": "private, no-store", "Retry-After": "2" });
          res.end();
          return true;
        }
        /* Если превью не удалось получить, отдаём исходный снимок. */
      }
      if (bytes) {
        const expectedRevision = (await archive.meta()).revision;
        const access = await permitted(req, url.pathname);
        if (!access) return denied(res);
        let delivered!: Promise<void>;
        return await deliver(req, res, access, url.pathname, expectedRevision, () => {
          delivered = finished(res, { cleanup: true }).catch(() => {});
          res.writeHead(200, {
            "Content-Type": "image/webp",
            "Content-Length": String(bytes.length),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
          });
          res.end(bytes);
        }, async () => { await delivered; });
      }
    }

    let handle: FileHandle | undefined;
    let delivering = false;
    try {
      handle = await openFile(file.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return json(res, 404, { error: "Фото не найдено" });
      }
      const expectedRevision = (await archive.meta()).revision;
      const access = await permitted(req, url.pathname);
      if (!access) {
        await handle.close();
        return denied(res);
      }
      // Read one fixed chunk before taking the final permission locks. The
      // checked response writes this chunk synchronously, then releases the
      // locks before a large original continues over a slow connection.
      const first = Buffer.allocUnsafe(Math.min(stat.size, 64 * 1024));
      const { bytesRead } = await handle.read(first, 0, first.length, 0);
      if (stat.size > 0 && bytesRead === 0)
        return json(res, 404, { error: "Фото не найдено" });
      const opened = handle;
      let delivered!: Promise<void>;
      delivering = true;
      return await deliver(req, res, access, url.pathname, expectedRevision, () => {
        delivered = finished(res, { cleanup: true }).catch(() => {});
        res.writeHead(200, {
          "Content-Type": file.type,
          "Content-Length": String(stat.size),
          ...(file.type === "application/pdf"
            ? { "Content-Disposition": `inline; filename="${file.name}"` }
            : file.type === "image/tiff"
              ? { "Content-Disposition": `attachment; filename="${file.name}"` }
              : {}),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        });
        if (bytesRead) res.write(first.subarray(0, bytesRead));
      }, async (signal) => {
        if (bytesRead >= stat.size) res.end();
        else await pipeline(opened.createReadStream({ start: bytesRead,
          end: stat.size - 1, signal }), res, { signal });
        await delivered;
      });
    } catch (error) {
      if (!res.headersSent) {
        if (delivering) throw error;
        return json(res, 404, { error: "Фото не найдено" });
      }
      if (!res.destroyed) res.destroy();
      return true;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  };
}
