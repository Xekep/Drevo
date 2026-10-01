-- Shared physical-disk headroom across archives on the same storage volume.
-- IDs are random; no archive, account or filename is stored in this table.
CREATE TABLE IF NOT EXISTS platform_upload_reservations (
  id text PRIMARY KEY,
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
  expires_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_upload_reservations_expiry
  ON platform_upload_reservations(expires_ms);
