import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { imagePreviews, ImagePreviewVariant } from "./image-previews.ts";
import type { mediaStore } from "./media.ts";
import type { settingsStore } from "./settings.ts";
import type { openArchive } from "./database.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { ownsPendingMedia } from "./media-access.ts";
import { allCitations } from "./source-catalog-store.ts";
import type { Family } from "../domain/types.ts";
import type { ArchiveUser } from "../domain/access.ts";

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
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  archive: Awaited<ReturnType<typeof openArchive>>;
}) {
  let cachedKey = "",
    cachedUrls = new Set<string>();
  const referenced = async (url: string, includePortraits: boolean) => {
    if (
      await archive.db
        .prepare(
          "SELECT 1 FROM photos WHERE json_extract(data,'$.url')=? LIMIT 1",
          "SELECT 1 FROM photos WHERE (data->>'url')=? LIMIT 1",
        )
        .get(url)
    )
      return true;
    return (
      includePortraits &&
      !!(await archive.db
        .prepare(
          "SELECT 1 FROM people WHERE json_extract(data,'$.photo')=? LIMIT 1",
          "SELECT 1 FROM people WHERE (data->>'photo')=? LIMIT 1",
        )
        .get(url))
    );
  };
  const permitted = async (req: IncomingMessage, url?: string): Promise<ArchiveUser | "public" | null> => {
    const canRead = await auth.canRead(req);
    if (!canRead && !(await visibility.read()).publicAlbums) return null;
    if (!url) return null;
    if (!canRead) {
      // Public albums expose only regular gallery images, never originals
      // attached solely as archive evidence.
      if (!media.open(url)) return null;
      // UUID is an identifier, not permission to view an unpublished upload.
      const settings = await visibility.read();
      return await referenced(url, settings.publicTree) ? "public" : null;
    }
    const user = await auth.currentUser(req);
    if (!user?.approved) return null;
    if (await ownsPendingMedia(archive.db, url, user.id)) return user;
    if (!isScopedUser(user))
      return (await referenced(url, true) ||
        citationUrls((await archive.read()).family).includes(url)) ? user : null;
    const key = `${(await archive.meta()).revision}:${user.id}:${user.personId || ""}`;
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
    if (cachedUrls.has(url)) return user;
    // Citation edits may happen through the source catalogue without changing
    // the tree revision. Re-evaluate visibility instead of caching a grant.
    return citationUrls(projectFamilyForUser((await archive.read()).family, user))
      .includes(url) ? user : null;
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
    access: ArchiveUser | "public",
    start: () => void,
    complete: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (access !== "public" && !auth.local && archive.db.kind === "postgres") {
      const session = await auth.accountSession(req);
      if (!session || session.accountId !== access.id) return denied(res);
      if (!archive.db.postgresTransaction || !archive.db.archiveId)
        throw new Error("PostgreSQL media delivery requires an archive transaction");
      try {
        const valid = await archive.db.postgresTransaction(async (client) => {
          // Hold the archive/session/member rows only until the first write.
          // A long original continues as an already-authorized HTTP request.
          const archived = await client.query("SELECT id FROM archives WHERE id=$1 FOR SHARE", [archive.db.archiveId]);
          if (!archived.rowCount) return false;
          const active = await client.query<{ expires_at: string }>(
            `SELECT expires_at FROM account_sessions
             WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [session.tokenHash, access.id],
          );
          if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now()) return false;
          const member = await client.query<{
            role: string; approved: boolean; person_id: string | null; tree_access: string;
          }>(`SELECT role,approved,person_id,tree_access FROM archive_memberships
              WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [archive.db.archiveId, access.id]);
          const current = member.rows[0];
          if (!current?.approved || current.role !== access.role ||
              (current.person_id || "") !== (access.personId || "") ||
              current.tree_access !== (access.treeAccess || "all")) return false;
          start();
          return true;
        });
        if (!valid) return denied(res);
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
    const requested = url.searchParams.get("variant");
    const variant: ImagePreviewVariant | null =
      requested === "tiny" || requested === "thumb" || requested === "display"
        ? requested : null;

    if (variant && media.open(url.pathname) && file.type !== "image/gif") {
      let bytes: Buffer | undefined;
      try {
        bytes = await previewImage(
          { path: file.path, cacheKey: file.name },
          variant,
        );
      } catch {
        /* Если превью не удалось получить, отдаём исходный снимок. */
      }
      if (bytes) {
        const access = await permitted(req, url.pathname);
        if (!access) return denied(res);
        let delivered!: Promise<void>;
        return await deliver(req, res, access, () => {
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
      return await deliver(req, res, access, () => {
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
