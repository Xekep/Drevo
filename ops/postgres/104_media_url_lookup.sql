-- Stored values allow leakproof text equality to use a scoped index under
-- FORCE RLS. A JSON expression index alone cannot push the non-leakproof
-- ->> expression through the row-security barrier.
SELECT pg_advisory_xact_lock(186743291);
ALTER TABLE people ADD COLUMN IF NOT EXISTS portrait_url text
  GENERATED ALWAYS AS (data->>'photo') STORED;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS media_url text
  GENERATED ALWAYS AS (data->>'url') STORED;
CREATE INDEX IF NOT EXISTS people_portrait_url
  ON people(archive_id,portrait_url) WHERE portrait_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_media_url
  ON photos(archive_id,media_url) WHERE media_url IS NOT NULL;
