-- Credentials are attached only after an email address has been verified.
-- OAuth identities are never inferred or merged by matching email addresses.
CREATE TABLE IF NOT EXISTS account_email_credentials (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  CHECK (email=lower(email) AND length(email) BETWEEN 3 AND 254)
);

CREATE TABLE IF NOT EXISTS pending_email_registrations (
  email text PRIMARY KEY,
  name text NOT NULL,
  password_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL,
  sent_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_email_registrations_expiry
  ON pending_email_registrations(expires_at);

CREATE TABLE IF NOT EXISTS email_password_resets (
  email text PRIMARY KEY REFERENCES account_email_credentials(email) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL,
  sent_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS email_password_resets_expiry
  ON email_password_resets(expires_at);
