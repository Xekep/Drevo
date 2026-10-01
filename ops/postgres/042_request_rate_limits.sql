-- One budget across backend processes and archive runtimes. Keys are hashed;
-- no plaintext IP address or account identifier is stored in this table.
CREATE TABLE IF NOT EXISTS request_rate_limits (
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 80),
  key_hash text NOT NULL CHECK (length(key_hash)=64),
  started_at bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000001),
  PRIMARY KEY (scope,key_hash)
);
CREATE INDEX IF NOT EXISTS request_rate_limits_expiry
  ON request_rate_limits(started_at);
