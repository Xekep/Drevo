-- Platform-wide email protection; keys share the platform encryption key.
ALTER TABLE platform_email_auth_settings
  ADD COLUMN IF NOT EXISTS captcha_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS captcha_site_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS captcha_secret_cipher text NOT NULL DEFAULT '';

-- Independent from hard limits: a solved challenge never resets those limits.
CREATE TABLE IF NOT EXISTS email_login_attempts (
  key_hash text PRIMARY KEY CHECK (length(key_hash)=64),
  started_at bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS email_login_attempts_expiry ON email_login_attempts(started_at);
