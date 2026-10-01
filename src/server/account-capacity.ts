import type { StoreDatabase } from "./store-database.ts";
import { BASIC_MEDIA_BYTES } from "./postgres-media-quota.ts";
import { BASIC_PEOPLE_LIMIT } from "./postgres-people-quota.ts";

/** Usage is archive-local; only the owner of this active tree receives it. */
export async function accountCapacity(db: StoreDatabase, accountId: string) {
  if (db.kind !== "postgres") return { available: false as const };
  const row = await db
    .prepare(
      "",
      `WITH owner AS (
         SELECT t.full_access FROM archive_owners o
         JOIN account_tiers t ON t.account_id=o.user_id
         WHERE o.archive_id=current_setting('drevo.archive_id', true)
           AND o.user_id=?
       ), referenced AS (
         SELECT data->>'photo' AS url FROM people
         UNION SELECT data->>'url' AS url FROM photos
       )
       SELECT
         owner.full_access,
         (SELECT count(*) FROM people) AS people,
         COALESCE((SELECT sum(file_size) FROM documents),0)
         + COALESCE((
           SELECT sum(m.size_bytes) FROM media_originals m
           WHERE EXISTS (
             SELECT 1 FROM people p
             WHERE p.archive_id=m.archive_id AND p.data->>'photo'=m.url
           ) OR EXISTS (
             SELECT 1 FROM photos p
             WHERE p.archive_id=m.archive_id AND p.data->>'url'=m.url
           ) OR EXISTS (
             SELECT 1 FROM media_upload_grants g
             WHERE g.archive_id=m.archive_id AND g.url=m.url AND g.expires_ms>?
           )
         ),0) + COALESCE((SELECT sum((f->>'size')::bigint) FROM person_comments c,jsonb_array_elements(c.attachments) f),0) AS media_bytes,
         EXISTS (
           SELECT 1 FROM referenced r
           WHERE r.url LIKE '/media/%'
             AND NOT EXISTS (SELECT 1 FROM media_originals m WHERE m.url=r.url)
         ) AS unindexed
       FROM owner`,
    )
    .get(accountId, Date.now());
  if (!row) return { available: true as const, owned: false as const };
  return {
    available: true as const,
    owned: true as const,
    fullAccess: !!row.full_access,
    people: Number(row?.people || 0),
    peopleLimit: BASIC_PEOPLE_LIMIT,
    mediaBytes: row?.unindexed ? null : Number(row?.media_bytes || 0),
    mediaLimitBytes: BASIC_MEDIA_BYTES,
  };
}
