CREATE TABLE IF NOT EXISTS published_people (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id', true),
  person_id text NOT NULL,
  published_at text NOT NULL,
  published_by text NOT NULL,
  PRIMARY KEY (archive_id, person_id),
  FOREIGN KEY (archive_id, person_id) REFERENCES people(archive_id, id) ON DELETE CASCADE
);
ALTER TABLE published_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_people FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON published_people;
CREATE POLICY archive_scope ON published_people
  USING (archive_id = current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id = current_setting('drevo.archive_id', true));
