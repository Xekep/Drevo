CREATE TABLE IF NOT EXISTS source_catalog (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY (archive_id,id)
);
ALTER TABLE source_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON source_catalog;
CREATE POLICY archive_scope ON source_catalog
  USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
