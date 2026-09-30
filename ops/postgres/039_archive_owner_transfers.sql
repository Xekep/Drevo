-- Ownership changes require the proposed new owner to accept while both
-- accounts are still members of the same archive.
CREATE TABLE IF NOT EXISTS archive_owner_transfers (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  from_user_id text NOT NULL REFERENCES accounts(id),
  to_user_id text NOT NULL REFERENCES accounts(id),
  created_ms bigint NOT NULL,
  expires_ms bigint NOT NULL CHECK (expires_ms > created_ms),
  CHECK (from_user_id <> to_user_id)
);
ALTER TABLE archive_owner_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_owner_transfers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON archive_owner_transfers;
CREATE POLICY archive_scope ON archive_owner_transfers
  USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
