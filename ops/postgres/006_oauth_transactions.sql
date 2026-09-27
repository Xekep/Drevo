-- OAuth state exists before the account and archive are known.
CREATE TABLE IF NOT EXISTS oauth_transactions (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  verifier text NOT NULL CHECK (verifier ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_transactions_expiry
  ON oauth_transactions(expires_at);
