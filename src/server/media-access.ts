import { enforceUserStorageLimit } from "./storage-limits.ts";
import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family, Person } from "../domain/types.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { ForbiddenError } from "./users.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";

/** Provenance for a newly uploaded file before it is attached to a card. */
export async function registerMediaUpload(
  db: StoreDatabase,
  url: string,
  userId: string,
  sizeBytes: number,
) {
  await db.transaction(async () => {
    await db
      .prepare(
        "DELETE FROM media_upload_grants WHERE expires_ms<?",
        "DELETE FROM media_upload_grants WHERE expires_ms<?",
      )
      .run(Date.now());
    await recordMediaOriginal(db, url, sizeBytes, userId);
    await db
      .prepare(
        "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES(?,?,?)",
        "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES(?,?,?)",
      )
      .run(url, userId, Date.now() + 24 * 60 * 60_000);
    await enforcePostgresMediaQuota(db);
    await enforceUserStorageLimit(db, userId);
  });
  return async () =>
    await db.transaction(async () => {
      await db
        .prepare(
          "DELETE FROM media_upload_grants WHERE url=?",
          "DELETE FROM media_upload_grants WHERE url=?",
        )
        .run(url);
      await db
        .prepare(
          "DELETE FROM media_originals WHERE url=?",
          "DELETE FROM media_originals WHERE url=?",
        )
        .run(url);
    });
}

export async function ownsPendingMedia(
  db: StoreDatabase,
  url: string,
  userId: string,
) {
  return !!(await db
    .prepare(
      "SELECT 1 FROM media_upload_grants WHERE url=? AND user_id=? AND expires_ms>?",
      "SELECT 1 FROM media_upload_grants WHERE url=? AND user_id=? AND expires_ms>?",
    )
    .get(url, userId, Date.now()));
}

/** Adding a reference must never grant access to a previously hidden file. */
export async function authorizeMediaReferences(
  db: StoreDatabase,
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
  const check = async (url?: string, previousPerson?: Person) => {
    if (
      url?.startsWith("/media/") &&
      !allowed.has(url) &&
      !(await ownsPendingMedia(db, url, user.id))
    ) {
      // Scoped writes keep full snapshots: undo may restore the owner's prior
      // portrait after a temporary upload grant expires.
      if (
        previousPerson?.createdBy === user.id &&
        (await db
          .prepare(
            `
        SELECT 1 FROM history h,json_each(h.data,'$.people') p
        WHERE json_extract(p.value,'$.id')=?
          AND json_extract(p.value,'$.createdBy')=?
          AND json_extract(p.value,'$.photo')=? LIMIT 1
      `,
            "SELECT 1 FROM history h CROSS JOIN LATERAL jsonb_array_elements(COALESCE(h.data->'people','[]'::jsonb)) p(value) WHERE p.value->>'id'=? AND p.value->>'createdBy'=? AND p.value->>'photo'=? LIMIT 1",
          )
          .get(previousPerson.id, user.id, url))
      )
        return;
      throw new ForbiddenError("Нет доступа к выбранному изображению");
    }
  };
  const people = new Map(before.people.map((p) => [p.id, p]));
  for (const p of after.people)
    if (p.photo !== people.get(p.id)?.photo)
      await check(p.photo, people.get(p.id));
  const photos = new Map((before.photos || []).map((p) => [p.id, p.url]));
  for (const p of after.photos || [])
    if (p.url !== photos.get(p.id)) await check(p.url);
}
