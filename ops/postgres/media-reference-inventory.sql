-- Read-only, all-archive inventory of database-tracked original media.
-- Run as a PostgreSQL administrator. row_security=off makes a runtime role
-- fail instead of silently reporting only its current archive.
-- "unreferenced_in_db" is NOT permission to delete a file: old backups and
-- unindexed filesystem originals are outside this report.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '60s';

WITH current_images AS (
  SELECT archive_id, data->>'photo' AS url FROM people
  WHERE data->>'photo' LIKE '/media/%'
  UNION
  SELECT archive_id, data->>'url' AS url FROM photos
  WHERE data->>'url' LIKE '/media/%'
),
historical_images AS (
  SELECT DISTINCT h.archive_id, '/media/' || (match.parts)[1] AS url
  FROM history h
  CROSS JOIN LATERAL regexp_matches(
    h.data::text,
    '/media/([A-Za-z0-9-]+\.(jpg|png|webp|gif))',
    'g'
  ) AS match(parts)
  WHERE h.data::text LIKE '%/media/%'
),
pending_images AS (
  SELECT DISTINCT archive_id, url FROM media_upload_grants
  WHERE expires_ms > floor(extract(epoch FROM transaction_timestamp())*1000)::bigint
),
classified AS (
  SELECT m.archive_id, m.size_bytes,
    CASE
      WHEN c.url IS NOT NULL THEN 'current_image'
      WHEN h.url IS NOT NULL THEN 'history_only_image'
      WHEN g.url IS NOT NULL THEN 'pending_image'
      ELSE 'unreferenced_in_db'
    END AS status
  FROM media_originals m
  LEFT JOIN current_images c ON c.archive_id=m.archive_id AND c.url=m.url
  LEFT JOIN historical_images h ON h.archive_id=m.archive_id AND h.url=m.url
  LEFT JOIN pending_images g ON g.archive_id=m.archive_id AND g.url=m.url
  UNION ALL
  SELECT d.archive_id, d.file_size, 'current_document' AS status
  FROM documents d
  UNION ALL
  SELECT c.archive_id, 0::bigint, 'image_missing_metadata' AS status
  FROM current_images c
  WHERE NOT EXISTS (
    SELECT 1 FROM media_originals m
    WHERE m.archive_id=c.archive_id AND m.url=c.url
  )
)
SELECT CASE WHEN GROUPING(archive_id)=1 THEN '*all*' ELSE archive_id END AS archive_id,
  status, count(*)::bigint AS files, sum(size_bytes)::bigint AS known_bytes
FROM classified
GROUP BY GROUPING SETS ((archive_id, status), (status))
ORDER BY archive_id, status;

COMMIT;
