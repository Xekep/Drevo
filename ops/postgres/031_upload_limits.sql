CREATE TABLE IF NOT EXISTS upload_limits (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id', true)
    REFERENCES archives(id) ON DELETE CASCADE,
  id integer NOT NULL DEFAULT 1 CHECK (id=1),
  data text NOT NULL,
  PRIMARY KEY (archive_id,id)
);
ALTER TABLE upload_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON upload_limits;
CREATE POLICY archive_scope ON upload_limits
  USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
