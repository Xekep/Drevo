-- Read-only, all-archive inventory of database-tracked original media.
-- Run as a PostgreSQL administrator. row_security=off makes a runtime role
-- fail instead of silently reporting only its current archive.
-- "unreferenced_in_db" is NOT permission to delete a file: old backups and
-- unindexed filesystem originals are outside this report.
-- Live restore previews retain current-upload fallbacks; files unpacked into
-- their own stage do not need the production original for that preview.
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
historical_images AS (
  SELECT DISTINCT h.archive_id, '/media/' || (match.parts)[1] AS url
  FROM history h
  CROSS JOIN LATERAL regexp_matches(
    h.data::text,
    '/media/([A-Za-z0-9-]+\.(jpg|png|webp|gif|tif|pdf))',
    'g'
  ) AS match(parts)
  WHERE h.data::text LIKE '%/media/%'
),
pending_images AS (
  SELECT DISTINCT archive_id, url FROM media_upload_grants
  WHERE expires_ms > floor(extract(epoch FROM transaction_timestamp())*1000)::bigint
),
live_restores AS (
  SELECT archive_id, data, directory FROM workflow_stages
  WHERE kind='restore'
    AND expires_at > floor(extract(epoch FROM transaction_timestamp())*1000)::bigint
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
classified AS (
  SELECT m.archive_id, m.size_bytes,
    CASE
      WHEN c.url IS NOT NULL THEN 'current_image'
      WHEN cited.url IS NOT NULL THEN 'current_citation'
      WHEN h.url IS NOT NULL THEN 'history_only_image'
      WHEN g.url IS NOT NULL THEN 'pending_image'
      WHEN r.url IS NOT NULL THEN 'restore_stage_image'
      ELSE 'unreferenced_in_db'
    END AS status
  FROM media_originals m
  LEFT JOIN current_images c ON c.archive_id=m.archive_id AND c.url=m.url
  LEFT JOIN current_citations cited ON cited.archive_id=m.archive_id AND cited.url=m.url
  LEFT JOIN historical_images h ON h.archive_id=m.archive_id AND h.url=m.url
  LEFT JOIN pending_images g ON g.archive_id=m.archive_id AND g.url=m.url
  LEFT JOIN restore_current_images r ON r.archive_id=m.archive_id AND r.url=m.url
  UNION ALL
  SELECT d.archive_id, d.file_size, 'current_document' AS status
  FROM documents d
  UNION ALL
  SELECT r.archive_id, r.file_size, 'restore_stage_document' AS status
  FROM restore_current_documents r
  WHERE NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.archive_id=r.archive_id AND d.file_name=r.file_name
  )
  UNION ALL
  SELECT c.archive_id, 0::bigint, 'image_missing_metadata' AS status
  FROM current_images c
  WHERE NOT EXISTS (
    SELECT 1 FROM media_originals m
    WHERE m.archive_id=c.archive_id AND m.url=c.url
  )
  UNION ALL
  SELECT c.archive_id, 0::bigint, 'citation_missing_metadata' AS status
  FROM current_citations c
  WHERE NOT EXISTS (
    SELECT 1 FROM media_originals m
    WHERE m.archive_id=c.archive_id AND m.url=c.url
  ) AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.archive_id=c.archive_id AND '/media/'||d.file_name=c.url
  ) AND NOT EXISTS (
    SELECT 1 FROM current_images i
    WHERE i.archive_id=c.archive_id AND i.url=c.url
  )
  UNION ALL
  SELECT r.archive_id, 0::bigint, 'restore_stage_image_missing_metadata' AS status
  FROM restore_current_images r
  WHERE NOT EXISTS (
    SELECT 1 FROM current_images c
    WHERE c.archive_id=r.archive_id AND c.url=r.url
  ) AND NOT EXISTS (
    SELECT 1 FROM media_originals m
    WHERE m.archive_id=r.archive_id AND m.url=r.url
  )
)
SELECT CASE WHEN GROUPING(archive_id)=1 THEN '*all*' ELSE archive_id END AS archive_id,
  status, count(*)::bigint AS files, sum(size_bytes)::bigint AS known_bytes
FROM classified
GROUP BY GROUPING SETS ((archive_id, status), (status))
ORDER BY archive_id, status;

COMMIT;
