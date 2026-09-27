-- Provider subjects are identities, not account IDs. Imported SQLite user IDs
-- are Yandex subjects; new accounts can use opaque IDs.
CREATE TABLE IF NOT EXISTS account_identities (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, account_id)
);
