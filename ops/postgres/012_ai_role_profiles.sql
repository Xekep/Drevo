-- Existing ai_settings RLS and archive ownership also protect role profiles.
-- During initial import memberships are populated before runtime tables.
-- The runtime backfill reapplies this migration once ai_settings exists.
ALTER TABLE IF EXISTS ai_settings ADD COLUMN IF NOT EXISTS role_profiles text NOT NULL
  DEFAULT '{}' CHECK (jsonb_typeof(role_profiles::jsonb) = 'object');

ALTER TABLE archive_memberships DROP CONSTRAINT IF EXISTS archive_memberships_role_check;
ALTER TABLE archive_memberships ADD CONSTRAINT archive_memberships_role_check
  CHECK (role IN ('admin', 'researcher', 'relative', 'reader'));
