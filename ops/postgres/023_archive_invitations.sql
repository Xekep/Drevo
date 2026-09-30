-- One-use invitations belong to one archive. The bearer is stored only as a hash.
CREATE TABLE IF NOT EXISTS archive_invitations (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  token_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('reader', 'relative')),
  created_by text NOT NULL REFERENCES accounts(id),
  created_at text NOT NULL,
  expires_at text NOT NULL,
  used_by text REFERENCES accounts(id),
  used_at text,
  revoked_at text,
  PRIMARY KEY (archive_id, id),
  UNIQUE (token_hash),
  CHECK ((used_by IS NULL) = (used_at IS NULL))
);
CREATE INDEX IF NOT EXISTS archive_invitations_recent
  ON archive_invitations(archive_id, created_at DESC, id DESC);
ALTER TABLE archive_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON archive_invitations;
CREATE POLICY archive_scope ON archive_invitations
  USING (archive_id = current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id = current_setting('drevo.archive_id', true));
