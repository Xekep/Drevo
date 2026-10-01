-- Run with psql -qAt -X -v ON_ERROR_STOP=1 as a PostgreSQL administrator.
-- JSONL manifest for media-filesystem-inventory.ts. No files are changed.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '60s';

WITH refs AS (
  SELECT archive_id, substring(data->>'photo' FROM '^/media/(.+)$') AS name,
    'person' AS source, NULL::bigint AS known_bytes
  FROM people WHERE data->>'photo' LIKE '/media/%'
  UNION ALL
  SELECT archive_id, substring(data->>'url' FROM '^/media/(.+)$'),
    'photo', NULL::bigint
  FROM photos WHERE data->>'url' LIKE '/media/%'
  UNION ALL
  SELECT h.archive_id, (match.parts)[1], 'history', NULL::bigint
  FROM history h
  CROSS JOIN LATERAL regexp_matches(
    h.data::text, '/media/([A-Za-z0-9-]+\.(jpg|png|webp|gif))', 'g'
  ) AS match(parts)
  WHERE h.data::text LIKE '%/media/%'
  UNION ALL
  SELECT archive_id, substring(url FROM '^/media/(.+)$'),
    'upload_grant', NULL::bigint
  FROM media_upload_grants
  WHERE expires_ms > floor(extract(epoch FROM transaction_timestamp())*1000)::bigint
  UNION ALL
  SELECT archive_id, substring(url FROM '^/media/(.+)$'),
    'image_metadata', size_bytes
  FROM media_originals
  UNION ALL
  SELECT archive_id, file_name, 'document', file_size
  FROM documents
)
SELECT json_build_object('kind', 'archive', 'archive_id', id)::text
FROM archives
UNION ALL
SELECT json_build_object('kind', 'ref', 'archive_id', archive_id,
  'name', name, 'source', source, 'known_bytes', known_bytes)::text
FROM refs;

COMMIT;
