import type pg from "pg";
import type { StoreDatabase } from "./store-database.ts";
import { UploadQuotaError } from "./upload-quota.ts";
import { postgresMediaReferencesSql, scopedPostgresMediaReferencesSql } from "./media-reference-sql.ts";
export { postgresMediaReferencesSql } from "./media-reference-sql.ts";

export const BASIC_MEDIA_BYTES = 500_000_000;

/** The legacy person-undo writer owns a pg.Client transaction rather than a
 * StoreDatabase. Count its archive explicitly, including temporary grants.
 */
export async function postgresArchiveMediaBytes(
  client: pg.Client,
  archiveId: string,
  now = Date.now(),
) {
  await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
  const row = (await client.query(
    `WITH referenced AS (${scopedPostgresMediaReferencesSql}) SELECT
      COALESCE((SELECT sum(file_size) FROM documents WHERE archive_id=$1),0)
      + COALESCE((SELECT sum(m.size_bytes) FROM media_originals m
        WHERE m.archive_id=$1 AND (
          EXISTS (SELECT 1 FROM referenced r WHERE r.url=m.url)
          OR EXISTS (SELECT 1 FROM media_upload_grants g
            WHERE g.archive_id=$1 AND g.url=m.url AND g.expires_ms>$2)
        )),0)
      + COALESCE((SELECT sum((f->>'size')::bigint)
        FROM person_comments c, jsonb_array_elements(c.attachments) f
        WHERE c.archive_id=$1),0) AS bytes`,
    [archiveId, now],
  )).rows[0];
  return Number(row.bytes);
}

/** Call after restoring dependencies, while holding the archive transaction.
 * The tier lock is retained through commit, just as in the live media writer.
 */
export async function enforcePostgresArchiveMediaQuota(
  client: pg.Client,
  archiveId: string,
  previousBytes: number,
  now = Date.now(),
) {
  const owner = (await client.query(
    "SELECT user_id FROM archive_owners WHERE archive_id=$1 FOR SHARE",
    [archiveId],
  )).rows[0];
  if (!owner) throw new Error("Не определён владелец архива");
  const tier = (await client.query(
    "SELECT full_access FROM account_tiers WHERE account_id=$1 FOR UPDATE",
    [owner.user_id],
  )).rows[0];
  if (!tier) throw new Error("Не определён уровень доступа владельца архива");
  if (tier.full_access) return;

  await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
  const unaccounted = (await client.query(
    `WITH referenced AS (${scopedPostgresMediaReferencesSql})
     SELECT 1 FROM referenced r WHERE r.url LIKE '/media/%'
       AND NOT EXISTS (SELECT 1 FROM media_originals m
         WHERE m.archive_id=$1 AND m.url=r.url) LIMIT 1`,
    [archiveId],
  )).rowCount;
  if (unaccounted)
    throw new UploadQuotaError("Размер одного из фото архива не подтверждён. Проверьте файл перед загрузкой.", 507);

  const used = await postgresArchiveMediaBytes(client, archiveId, now);
  if (used > BASIC_MEDIA_BYTES && used > previousBytes)
    throw new UploadQuotaError("Базовый доступ владельца ограничен 500 МБ фотографий и документов.", 507);
}

/** Local originals can also be referenced only by a citation. Strip page
 * fragments/query strings before comparing with the stored original URL.
 * The EXISTS below counts an original once even when several facts cite it.
 */

/** Referenced originals and live temporary grants are counted once per URL. */
export async function postgresMediaBytes(db: StoreDatabase, now = Date.now()) {
  if (db.kind !== "postgres") return 0;
  const used = await db
    .prepare(
      "",
      `WITH referenced AS (${postgresMediaReferencesSql}) SELECT
        COALESCE((SELECT sum(file_size) FROM documents),0)
        + COALESCE((
          SELECT sum(m.size_bytes) FROM media_originals m
          WHERE EXISTS (
            SELECT 1 FROM referenced r WHERE r.url=m.url
          ) OR EXISTS (
            SELECT 1 FROM media_upload_grants g
            WHERE g.archive_id=m.archive_id
              AND g.url=m.url AND g.expires_ms>?
          )
        ),0) + COALESCE((SELECT sum((f->>'size')::bigint) FROM person_comments c,jsonb_array_elements(c.attachments) f),0) AS bytes`,
    )
    .get(now);
  return Number(used?.bytes || 0);
}

/** A newly attached file no longer needs its temporary upload grant. Removing
 * the last reference can then free the owner's quota immediately.
 */
export async function releaseAttachedMediaGrants(db: StoreDatabase) {
  await db.exec(
    `DELETE FROM media_upload_grants WHERE
      EXISTS (SELECT 1 FROM people p WHERE json_extract(p.data,'$.photo')=media_upload_grants.url)
      OR EXISTS (SELECT 1 FROM photos p WHERE json_extract(p.data,'$.url')=media_upload_grants.url)`,
    `DELETE FROM media_upload_grants g
     WHERE EXISTS (
       SELECT 1 FROM people p
       WHERE p.archive_id=g.archive_id
         AND p.data->>'photo'=g.url
     ) OR EXISTS (
       SELECT 1 FROM photos p
       WHERE p.archive_id=g.archive_id
         AND p.data->>'url'=g.url
     )`,
  );
}

/** Check the owner's committed originals, not the upload's maximum stream size.
 * The caller must have written its metadata in the current archive transaction.
 * That transaction locks the archive row, serializing concurrent commits.
 * previousBytes permits only non-growing attachment of an already counted file.
 */
export async function enforcePostgresMediaQuota(
  db: StoreDatabase,
  previousBytes?: number,
  now = Date.now(),
) {
  if (db.kind !== "postgres") return;
  if (!db.inTransaction())
    throw new Error("Проверка квоты требует транзакции архива");

  const owner = await db
    .prepare(
      "",
      `SELECT t.full_access FROM archive_owners o
       JOIN account_tiers t ON t.account_id=o.user_id
       WHERE o.archive_id=current_setting('drevo.archive_id', true)
       FOR UPDATE OF t`,
    )
    .get();
  if (!owner)
    throw new Error("Не определён владелец или уровень доступа архива");
  if (owner.full_access) return;

  const unaccounted = await db
    .prepare(
      "",
      `WITH referenced AS (${postgresMediaReferencesSql})
       SELECT 1 FROM referenced r
       WHERE r.url LIKE '/media/%'
         AND NOT EXISTS (SELECT 1 FROM media_originals m WHERE m.url=r.url)
       LIMIT 1`,
    )
    .get();
  if (unaccounted)
    throw new UploadQuotaError(
      "Размер одного из фото архива не подтверждён. Проверьте файл перед загрузкой.",
      507,
    );

  const used = await postgresMediaBytes(db, now);
  if (used > BASIC_MEDIA_BYTES &&
      (previousBytes === undefined || used > previousBytes))
    throw new UploadQuotaError(
      "Базовый доступ владельца ограничен 500 МБ фотографий и документов.",
      507,
    );
}
