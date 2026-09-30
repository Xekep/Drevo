-- Linking an email to an OAuth account requires both its active session and
-- proof that the account owner controls the new mailbox.
CREATE TABLE IF NOT EXISTS pending_email_links (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL,
  sent_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_email_links_expiry
  ON pending_email_links(expires_at);
