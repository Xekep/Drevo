CREATE SEQUENCE IF NOT EXISTS runtime_family_unions_ordinal;
CREATE TABLE IF NOT EXISTS family_unions (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id', true) REFERENCES archives(id) ON DELETE CASCADE,
  id text NOT NULL,
  ordinal bigint NOT NULL DEFAULT nextval('runtime_family_unions_ordinal'),
  participant_a text NOT NULL,
  participant_b text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (archive_id, id),
  UNIQUE (archive_id, ordinal),
  CHECK (participant_a <> participant_b),
  FOREIGN KEY (archive_id, participant_a) REFERENCES people(archive_id, id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, participant_b) REFERENCES people(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS family_unions_participant_a ON family_unions(archive_id, participant_a);
CREATE INDEX IF NOT EXISTS family_unions_participant_b ON family_unions(archive_id, participant_b);
ALTER TABLE family_unions ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_unions FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_scope ON family_unions
  USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
