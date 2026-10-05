import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { settingsStore } from "./settings.ts";
import type { GeocodingStore } from "./geocoding.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { familyPlaces, placeKey } from "../domain/places.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { finished } from "node:stream/promises";
import { assertMemberPreviewDelivery, memberPreviewTarget,
  samePreviewMember } from "./member-preview-access.ts";

export function placesHttp({
  archive,
  auth,
  visibility,
  geocoding,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  geocoding: GeocodingStore;
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
    if (url.pathname !== "/api/places/locate") return false;
    if (req.method !== "GET") return json(res, 405, { error: "Ожидается GET" });

    const access = await visibility.read();
    if (
      !(await auth.canRead(req)) &&
      !access.publicTree &&
      !access.publicAlbums
    )
      return json(res, 401, { error: "Войдите для просмотра мест семьи" });
    if (
      req.headers["x-drevo-map"] !== "1" ||
      !isSameOriginRequest(req, publicOrigin)
    )
      return json(res, 403, { error: "Откройте карту в архиве" });

    const query = (url.searchParams.get("q") || "").trim();
    const preview = memberPreviewTarget(req);
    const target = preview ? await auth.currentUser(req) : null;
    const revision = preview ? (await archive.meta()).revision : null;
    const permittedQuery = async () => {
      if (await auth.canEdit(req)) return true;
      const settings = await visibility.read(),
        { family } = await archive.read(),
        subject = await auth.currentUser(req);
      if (preview && (!target || !samePreviewMember(subject, target))) return false;
      const projected = isScopedUser(subject) ? projectFamilyForUser(family, subject) : family,
        people =
          (await auth.canRead(req)) || settings.publicTree ? projected.people : [],
        photos =
          (await auth.canRead(req)) || settings.publicAlbums
            ? projected.photos
            : [];
      return familyPlaces(people, photos).some(
        (place) => place.key === placeKey(query),
      );
    };

    if (!(await permittedQuery()))
      return json(res, 403, {
        error: "Можно искать только места из доступного архива",
      });
    try {
      const result = await geocoding.locate(query);
      if (!(await permittedQuery()))
        return json(res, 403, { error: "Доступ к этому месту закрыт" });
      if (preview) {
        if (!target) return json(res, 403, { error: "Предпросмотр недоступен" });
        if (auth.local || archive.db.kind !== "postgres") {
          if ((await archive.meta()).revision !== revision ||
              !samePreviewMember(await auth.currentUser(req), target))
            return json(res, 409, { error: "Права предпросмотра изменились" });
          return json(res, 200, result);
        }
        const session = await auth.accountSession(req);
        if (!session || !archive.db.archiveId ||
            !archive.db.postgresTransaction)
          return json(res, 403, { error: "Предпросмотр недоступен" });
        const body = JSON.stringify(result);
        const delivered = await archive.db.postgresTransaction(async (client) => {
          await client.query("SELECT set_config('drevo.archive_id',$1,true)",
            [archive.db.archiveId]);
          const locked = await client.query<{ revision: string }>(
            "SELECT revision FROM archives WHERE id=$1 FOR SHARE NOWAIT",
            [archive.db.archiveId]);
          if (Number(locked.rows[0]?.revision) !== revision) return false;
          const expiresAt = await assertMemberPreviewDelivery(client,
            archive.db.archiveId!, session, target);
          if (!expiresAt) return false;
          const remaining = Math.min(4_000, expiresAt - Date.now());
          if (remaining <= 0 || Date.now() >= expiresAt) return false;
          const sent = finished(res, { cleanup: true });
          const timer = setTimeout(() => res.destroy(), remaining);
          timer.unref();
          try {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "private, no-store" });
            res.end(body);
            await sent;
          } finally { clearTimeout(timer); }
          return true;
        });
        return delivered ? true : json(res, 409, { error: "Права предпросмотра изменились" });
      }
      return json(res, 200, result);
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return true; }
      if ((error as { code?: string }).code === "55P03")
        return json(res, 409, { error: "Права предпросмотра меняются" });
      return json(res, 400, { error: (error as Error).message });
    }
  };
}
