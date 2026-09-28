CREATE TABLE IF NOT EXISTS vk_auth_settings (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id', true) REFERENCES archives(id) ON DELETE CASCADE,
  id bigint NOT NULL CHECK(id=1),
  enabled bigint NOT NULL CHECK(enabled IN (0,1)),
  client_id text NOT NULL,
  PRIMARY KEY(archive_id,id)
);
ALTER TABLE vk_auth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE vk_auth_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_isolation ON vk_auth_settings;
CREATE POLICY archive_isolation ON vk_auth_settings
  USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
