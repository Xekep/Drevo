-- Global platform configuration, installed by the primary runtime only.
CREATE TABLE IF NOT EXISTS platform_email_auth_settings (
  id integer PRIMARY KEY CHECK (id=1),
  enabled boolean NOT NULL,
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  smtp_user text NOT NULL,
  sender text NOT NULL,
  password_cipher text NOT NULL
);
