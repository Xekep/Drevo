import type { StoreDatabase } from "./store-database.ts";
import type pg from "pg";
import { PlatformAccessBusy } from "./platform-access.ts";
import { BASIC_MEDIA_BYTES, postgresMediaReferencesSql } from "./postgres-media-quota.ts";
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
       ), referenced AS (${postgresMediaReferencesSql})
       SELECT
         owner.full_access,
         (SELECT count(*) FROM people) AS people,
         (SELECT count(*) FROM photos) AS photos,
         (SELECT count(*) FROM documents) AS documents,
         (SELECT count(*) FROM person_comments) AS comments,
         (SELECT count(*) FROM source_catalog) AS sources,
         COALESCE((SELECT sum(file_size) FROM documents),0)
         + COALESCE((
           SELECT sum(m.size_bytes) FROM media_originals m
           WHERE EXISTS (
             SELECT 1 FROM referenced r WHERE r.url=m.url
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
    emptyArchive: !(
      Number(row.people) || Number(row.photos) || Number(row.documents) ||
      Number(row.comments) || Number(row.sources)
    ),
    peopleLimit: BASIC_PEOPLE_LIMIT,
    mediaBytes: row?.unindexed ? null : Number(row?.media_bytes || 0),
    mediaLimitBytes: BASIC_MEDIA_BYTES,
  };
}

/** Count-only platform view of one account's owned archive. The caller must
 * hold the platform grant and target account lock on this same PG client. */
export async function platformOwnedArchiveCapacity(client: pg.PoolClient, accountId: string,
  beforeOwnerLock?: () => Promise<void>) {
  const scope = await client.query<{ archive_id: string; account_id: string }>(
    `SELECT current_setting('drevo.archive_id',true) AS archive_id,
      current_setting('drevo.account_id',true) AS account_id`);
  const previousArchive = scope.rows[0].archive_id || "";
  const previousAccount = scope.rows[0].account_id || "";
  const restoreScope = async () => {
    try {
      await client.query("SELECT set_config('drevo.archive_id',$1,true)", [previousArchive]);
      await client.query("SELECT set_config('drevo.account_id',$1,true)", [previousAccount]);
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "25P02") throw error;
    }
  };
  try {
    await client.query("SELECT set_config('drevo.account_id',$1,true)", [accountId]);
    // The account-directory SELECT policy permits finding this account's own
    // archive. FOR SHARE additionally needs the archive UPDATE policy, so
    // switch only to that server-read owner ID before locking its row.
    const owned = await client.query<{ archive_id: string }>(
      `SELECT archive_id FROM archive_owners WHERE user_id=$1
       ORDER BY archive_id COLLATE "C"`, [accountId]);
    if (!owned.rowCount) return { owned: false as const, people: null, mediaBytes: null };
    // The unique owner index guarantees at most one archive. The only scope
    // switch comes from the locked owner row, never a client archive id.
    if (owned.rowCount !== 1) throw new Error("Owner archive uniqueness is missing");
    const archiveId = owned.rows[0].archive_id;
    await beforeOwnerLock?.();
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
    const lockedOwner = await client.query(
      `SELECT 1 FROM archive_owners WHERE archive_id=$1 AND user_id=$2
       FOR SHARE NOWAIT`, [archiveId, accountId]);
    if (!lockedOwner.rowCount) throw new PlatformAccessBusy(
      "Владелец дерева изменился. Повторите проверку расхода");
    await client.query("SET LOCAL statement_timeout='3s'");
    const usage = await client.query<{ people: string; media_bytes: string; unindexed: boolean }>(
      `WITH referenced AS (${postgresMediaReferencesSql}) SELECT
         (SELECT count(*)::text FROM people) AS people,
         (COALESCE((SELECT sum(file_size) FROM documents),0)
         + COALESCE((SELECT sum(m.size_bytes) FROM media_originals m
           WHERE EXISTS (SELECT 1 FROM referenced r WHERE r.url=m.url)
              OR EXISTS (SELECT 1 FROM media_upload_grants g
                WHERE g.archive_id=m.archive_id AND g.url=m.url AND g.expires_ms>$1)),0)
         + COALESCE((SELECT sum((f->>'size')::bigint)
           FROM person_comments c,jsonb_array_elements(c.attachments) f),0))::text AS media_bytes,
         EXISTS (SELECT 1 FROM referenced r WHERE r.url LIKE '/media/%'
           AND NOT EXISTS (SELECT 1 FROM media_originals m WHERE m.url=r.url)) AS unindexed`,
      [Date.now()]);
    return { owned: true as const, people: Number(usage.rows[0].people),
      mediaBytes: usage.rows[0].unindexed ? null : Number(usage.rows[0].media_bytes) };
  } finally {
    // A failed SQL statement aborts the transaction; its rollback restores
    // both LOCAL scopes. A live transaction must restore them explicitly.
    await restoreScope();
  }
}
