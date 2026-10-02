-- Run with psql -qAt -X -v ON_ERROR_STOP=1 as a PostgreSQL administrator.
-- JSONL manifest for media-filesystem-inventory.ts. No files are changed.
-- Include live restore previews that still read from production uploads.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '60s';

WITH live_restores AS (
  SELECT archive_id, data, directory FROM workflow_stages
  WHERE kind='restore'
    AND expires_at > floor(extract(epoch FROM transaction_timestamp())*1000)::bigint
),
current_citations AS (
  SELECT DISTINCT archive_id, url FROM (
    SELECT p.archive_id, split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1) AS url
    FROM people p CROSS JOIN LATERAL jsonb_path_query(p.data, '$.**.sources[*].url') cited(value)
    UNION ALL
    SELECT u.archive_id, split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM family_unions u CROSS JOIN LATERAL jsonb_path_query(u.data, '$.**.sources[*].url') cited(value)
    UNION ALL
    SELECT r.archive_id, split_part(split_part(cited.value #>> '{}', '#', 1), '?', 1)
    FROM relations r CROSS JOIN LATERAL jsonb_path_query(r.sources, '$[*].url') cited(value)
  ) citations
  WHERE url ~ '^/media/[A-Za-z0-9-]+\.(jpg|png|webp|gif|tif|pdf)$'
),
restore_images AS (
  SELECT s.archive_id, s.data, p.value->>'photo' AS url
  FROM live_restores s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'family'->'people','[]'::jsonb)) p(value)
  UNION ALL
  SELECT s.archive_id, s.data, p.value->>'url'
  FROM live_restores s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'family'->'photos','[]'::jsonb)) p(value)
),
restore_current_images AS (
  SELECT DISTINCT r.archive_id, r.url FROM restore_images r
  WHERE r.url LIKE '/media/%'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(r.data->'files','[]'::jsonb)) f(value)
      WHERE f.value->>0=r.url
    )
),
restore_current_documents AS (
  SELECT DISTINCT s.archive_id, d.value->>'fileName' AS file_name,
    (d.value->>'fileSize')::bigint AS file_size
  FROM live_restores s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'documents','[]'::jsonb)) d(value)
  JOIN LATERAL jsonb_array_elements(COALESCE(s.data->'documentFiles','[]'::jsonb)) f(value)
    ON f.value->>0=d.value->>'id'
  WHERE s.directory IS NULL OR NOT (
    starts_with(f.value->>1,s.directory||'/')
    OR starts_with(f.value->>1,s.directory||chr(92))
  )
),
refs AS (
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
    h.data::text, '/media/([A-Za-z0-9-]+\.(jpg|png|webp|gif|tif|pdf))', 'g'
  ) AS match(parts)
  WHERE h.data::text LIKE '%/media/%'
  UNION ALL
  SELECT archive_id, substring(url FROM '^/media/(.+)$'),
    'citation', NULL::bigint
  FROM current_citations
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
  UNION ALL
  SELECT archive_id, substring(url FROM '^/media/(.+)$'),
    'restore_stage_image', NULL::bigint
  FROM restore_current_images
  UNION ALL
  SELECT archive_id, file_name, 'restore_stage_document', file_size
  FROM restore_current_documents
)
SELECT json_build_object('kind', 'archive', 'archive_id', id)::text
FROM archives
UNION ALL
SELECT json_build_object('kind', 'ref', 'archive_id', archive_id,
  'name', name, 'source', source, 'known_bytes', known_bytes)::text
FROM refs;

COMMIT;
