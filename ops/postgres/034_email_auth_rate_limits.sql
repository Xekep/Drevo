-- Public authentication limits must be shared by every backend instance.
-- Hashes avoid retaining raw IP addresses or attempted email addresses here.
CREATE TABLE IF NOT EXISTS email_auth_rate_limits (
  scope text NOT NULL CHECK (scope IN ('ip', 'email')),
  key_hash text NOT NULL CHECK (length(key_hash)=64),
  started_at bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000),
  PRIMARY KEY (scope,key_hash)
);
CREATE INDEX IF NOT EXISTS email_auth_rate_limits_expiry
  ON email_auth_rate_limits(started_at);
