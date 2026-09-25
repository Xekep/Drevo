import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family, Person } from "../domain/types.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { ForbiddenError } from "./users.ts";

/** Provenance for a newly uploaded file before it is attached to a card. */
export function registerMediaUpload(
  db: DatabaseSync,
  url: string,
  userId: string,
) {
  db.prepare("DELETE FROM media_upload_grants WHERE expires_ms<?").run(
    Date.now(),
  );
  db.prepare(
    "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES(?,?,?)",
  ).run(url, userId, Date.now() + 24 * 60 * 60_000);
  return () =>
    db.prepare("DELETE FROM media_upload_grants WHERE url=?").run(url);
}

export function ownsPendingMedia(
  db: DatabaseSync,
  url: string,
  userId: string,
) {
  return !!db
    .prepare(
      "SELECT 1 FROM media_upload_grants WHERE url=? AND user_id=? AND expires_ms>?",
    )
    .get(url, userId, Date.now());
}

/** Adding a reference must never grant access to a previously hidden file. */
export function authorizeMediaReferences(
  db: DatabaseSync,
  before: Family,
  after: Family,
  user: ArchiveUser,
) {
  if (!isScopedUser(user)) return;
  const visible = projectFamilyForUser(before, user);
  const allowed = new Set([
    ...visible.people.map((p) => p.photo).filter((url): url is string => !!url),
    ...(visible.photos || []).map((p) => p.url),
  ]);
  const check = (url?: string, previousPerson?: Person) => {
    if (
      url?.startsWith("/media/") &&
      !allowed.has(url) &&
      !ownsPendingMedia(db, url, user.id)
    ) {
      // Scoped writes keep full snapshots: undo may restore the owner's prior
      // portrait after a temporary upload grant expires.
      if (
        previousPerson?.createdBy === user.id &&
        db
          .prepare(
            `
        SELECT 1 FROM history h,json_each(h.data,'$.people') p
        WHERE json_extract(p.value,'$.id')=?
          AND json_extract(p.value,'$.createdBy')=?
          AND json_extract(p.value,'$.photo')=? LIMIT 1
      `,
          )
          .get(previousPerson.id, user.id, url)
      )
        return;
      throw new ForbiddenError("Нет доступа к выбранному изображению");
    }
  };
  const people = new Map(before.people.map((p) => [p.id, p]));
  for (const p of after.people)
    if (p.photo !== people.get(p.id)?.photo) check(p.photo, people.get(p.id));
  const photos = new Map((before.photos || []).map((p) => [p.id, p.url]));
  for (const p of after.photos || [])
    if (p.url !== photos.get(p.id)) check(p.url);
}
