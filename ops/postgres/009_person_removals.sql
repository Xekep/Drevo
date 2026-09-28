-- Server-owned undo receipts. They expire together with the last 50 revisions.
-- No FK to the removed person: the receipt must survive their deletion.
CREATE TABLE IF NOT EXISTS person_removals (
  archive_id text NOT NULL,
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  person_id text NOT NULL,
  base_revision bigint NOT NULL,
  restored_revision bigint CHECK (restored_revision > base_revision),
  inverse_changes jsonb NOT NULL CHECK (jsonb_typeof(inverse_changes) = 'array'),
  dependencies jsonb NOT NULL CHECK (jsonb_typeof(dependencies) = 'object'),
  PRIMARY KEY (archive_id, request_id),
  FOREIGN KEY (archive_id, base_revision) REFERENCES history(archive_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS person_removals_history ON person_removals(archive_id, base_revision);
