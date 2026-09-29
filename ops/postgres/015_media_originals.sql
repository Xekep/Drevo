-- Original image metadata is archive-scoped; previews and backups are not
-- user originals. Existing references are indexed from disk at startup.
CREATE TABLE IF NOT EXISTS media_originals (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id', true)
    REFERENCES archives(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (url ~ '^/media/[a-zA-Z0-9-]+\.(jpg|png|webp|gif)$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_by text,
  created_at text NOT NULL DEFAULT (now()::text),
  PRIMARY KEY (archive_id, url)
);
ALTER TABLE media_originals ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_originals FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_scope ON media_originals
  USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
