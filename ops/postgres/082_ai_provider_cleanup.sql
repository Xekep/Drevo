-- Platform-owned cleanup work must outlive archive, membership and account cascades.
CREATE TABLE IF NOT EXISTS platform_ai_cleanup_keys (
  version integer PRIMARY KEY CHECK (version = 1),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS platform_ai_conversations (
  id uuid PRIMARY KEY,
  key_version integer NOT NULL REFERENCES platform_ai_cleanup_keys(version),
  encrypted_snapshot text,
  archive_id text NOT NULL,
  local_chat_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('binding','active','pending','leased','blocked','done')),
  available_at bigint NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (state='done' OR encrypted_snapshot IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_ai_conversations_due
  ON platform_ai_conversations(state,available_at) WHERE state IN ('binding','pending','leased');

ALTER TABLE ai_chats ADD COLUMN IF NOT EXISTS provider_cleanup_ref uuid;
-- This is deliberately not a foreign key: a cascaded local chat deletion must
-- never erase the platform cleanup obligation.
