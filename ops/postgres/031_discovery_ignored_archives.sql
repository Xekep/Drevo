CREATE TABLE IF NOT EXISTS discovery_ignored_archives (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  target_archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  ignored_by text NOT NULL,
  ignored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archive_id,target_archive_id),
  CHECK (archive_id<>target_archive_id)
);
ALTER TABLE discovery_ignored_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_ignored_archives FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_scope ON discovery_ignored_archives;
CREATE POLICY owner_scope ON discovery_ignored_archives
  USING (archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id',true));
