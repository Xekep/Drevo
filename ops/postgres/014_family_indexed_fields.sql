-- Queryable family fields remain projections of the original JSONB payload.
-- The payload is unchanged, so existing portable backups and API responses
-- keep their current shape. PostgreSQL refreshes these columns on every edit.
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS surname_search text GENERATED ALWAYS AS
    (replace(lower(btrim(coalesce(data->>'surname', ''))), 'ё', 'е')) STORED,
  ADD COLUMN IF NOT EXISTS maiden_name_search text GENERATED ALWAYS AS
    (replace(lower(btrim(coalesce(data->>'maidenName', ''))), 'ё', 'е')) STORED,
  ADD COLUMN IF NOT EXISTS given_name_search text GENERATED ALWAYS AS
    (replace(lower(btrim(coalesce(data->>'name', ''))), 'ё', 'е')) STORED,
  ADD COLUMN IF NOT EXISTS birth_text text GENERATED ALWAYS AS
    (coalesce(data->>'birth', '')) STORED,
  ADD COLUMN IF NOT EXISTS birth_place_search text GENERATED ALWAYS AS
    (replace(lower(btrim(coalesce(data->>'birthPlace', ''))), 'ё', 'е')) STORED;

-- The archive prefix keeps tenant lookups bounded. Prefix pattern operators
-- support type-ahead search without a table-wide scan at larger tree sizes.
CREATE INDEX IF NOT EXISTS people_surname_name_search
  ON people(archive_id, surname_search text_pattern_ops, given_name_search text_pattern_ops);
CREATE INDEX IF NOT EXISTS people_maiden_name_search
  ON people(archive_id, maiden_name_search text_pattern_ops, given_name_search text_pattern_ops)
  WHERE maiden_name_search <> '';
CREATE INDEX IF NOT EXISTS people_birth_lookup
  ON people(archive_id, birth_text)
  WHERE birth_text <> '';
CREATE INDEX IF NOT EXISTS people_birth_place_search
  ON people(archive_id, birth_place_search text_pattern_ops)
  WHERE birth_place_search <> '';

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS title_search text GENERATED ALWAYS AS
    (replace(lower(btrim(coalesce(data->>'title', ''))), 'ё', 'е')) STORED,
  ADD COLUMN IF NOT EXISTS place_search text GENERATED ALWAYS AS
    (replace(lower(btrim(coalesce(data->>'place', ''))), 'ё', 'е')) STORED,
  ADD COLUMN IF NOT EXISTS taken_at_text text GENERATED ALWAYS AS
    (coalesce(data->>'takenAt', '')) STORED;
CREATE INDEX IF NOT EXISTS photos_title_search
  ON photos(archive_id, title_search text_pattern_ops);
CREATE INDEX IF NOT EXISTS photos_place_search
  ON photos(archive_id, place_search text_pattern_ops)
  WHERE place_search <> '';
CREATE INDEX IF NOT EXISTS photos_taken_at_lookup
  ON photos(archive_id, taken_at_text)
  WHERE taken_at_text <> '';

-- Relations and document metadata are already first-class columns. Their
-- existing endpoint and chronology indexes are retained; add document title
-- lookup for an archive-scoped catalog search.
CREATE INDEX IF NOT EXISTS documents_title_search
  ON documents(archive_id, title_search text_pattern_ops);
