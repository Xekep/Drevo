-- Opaque management IDs are separate from both bearer tokens and token hashes.
-- Existing sessions have no reliable login time; leave it unknown.
ALTER TABLE account_sessions
  ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE account_sessions
  ADD COLUMN IF NOT EXISTS created_at bigint;
ALTER TABLE account_sessions
  ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
CREATE UNIQUE INDEX IF NOT EXISTS account_sessions_public_id
  ON account_sessions(public_id);
CREATE INDEX IF NOT EXISTS account_sessions_user_created
  ON account_sessions(user_id, created_at DESC);
