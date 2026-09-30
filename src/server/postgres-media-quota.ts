import type { StoreDatabase } from "./store-database.ts";
import { UploadQuotaError } from "./upload-quota.ts";

export const BASIC_MEDIA_BYTES = 500_000_000;

/** Referenced originals and live temporary grants are counted once per URL. */
export async function postgresMediaBytes(db: StoreDatabase, now = Date.now()) {
  if (db.kind !== "postgres") return 0;
  const used = await db
    .prepare(
      "",
      `SELECT
        COALESCE((SELECT sum(file_size) FROM documents),0)
        + COALESCE((
          SELECT sum(m.size_bytes) FROM media_originals m
          WHERE EXISTS (
            SELECT 1 FROM people p
            WHERE p.archive_id=m.archive_id
              AND p.data->>'photo'=m.url
          ) OR EXISTS (
            SELECT 1 FROM photos p
            WHERE p.archive_id=m.archive_id
              AND p.data->>'url'=m.url
          ) OR EXISTS (
            SELECT 1 FROM media_upload_grants g
            WHERE g.archive_id=m.archive_id
              AND g.url=m.url AND g.expires_ms>?
          )
        ),0) AS bytes`,
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
      `WITH referenced AS (
         SELECT data->>'photo' AS url FROM people
         UNION SELECT data->>'url' AS url FROM photos
       )
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
