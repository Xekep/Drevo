CREATE TABLE IF NOT EXISTS share_link_activity (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id', true),
  share_id text NOT NULL,
  last_visited_at text NOT NULL,
  PRIMARY KEY (archive_id, share_id),
  FOREIGN KEY (archive_id, share_id)
    REFERENCES share_links(archive_id, id) ON DELETE CASCADE
);

ALTER TABLE share_link_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_link_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON share_link_activity;
CREATE POLICY archive_scope ON share_link_activity
  USING (archive_id = current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id = current_setting('drevo.archive_id', true));
