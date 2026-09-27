-- Historical audit records retain their SQLite IDs so pagination and references
-- remain stable after cutover. Actor and person IDs are intentionally not FKs:
-- audit history must survive account and person deletion.
CREATE TABLE IF NOT EXISTS archive_audit_entries (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id bigint NOT NULL,
  at text NOT NULL,
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  label text NOT NULL,
  revision bigint,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'array'),
  PRIMARY KEY (archive_id, id)
);
CREATE INDEX IF NOT EXISTS archive_audit_actor
  ON archive_audit_entries(archive_id, actor_id, id DESC);

CREATE TABLE IF NOT EXISTS archive_audit_people (
  archive_id text NOT NULL,
  entry_id bigint NOT NULL,
  person_id text NOT NULL,
  PRIMARY KEY (archive_id, entry_id, person_id),
  FOREIGN KEY (archive_id, entry_id)
    REFERENCES archive_audit_entries(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS archive_audit_person
  ON archive_audit_people(archive_id, person_id, entry_id DESC);
