-- A platform grant never creates an archive membership. Existing archive
-- administrators/researchers become ordinary editable members; ownership is
-- retained separately in archive_owners. Do not infer a platform grant from
-- any legacy archive role.
CREATE TABLE IF NOT EXISTS platform_researchers (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_role_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text REFERENCES accounts(id) ON DELETE SET NULL,
  target_id text REFERENCES accounts(id) ON DELETE SET NULL,
  old_role text CHECK (old_role IN ('admin','researcher')),
  new_role text CHECK (new_role IN ('admin','researcher')),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (old_role IS DISTINCT FROM new_role)
);
CREATE INDEX IF NOT EXISTS platform_role_audit_target
  ON platform_role_audit(target_id,changed_at DESC,id DESC);

UPDATE archive_memberships SET role='relative'
 WHERE role IN ('admin','researcher');
ALTER TABLE archive_memberships DROP CONSTRAINT IF EXISTS archive_memberships_role_check;
ALTER TABLE archive_memberships ADD CONSTRAINT archive_memberships_role_check
  CHECK (role IN ('reader','relative')) NOT VALID;

-- FORCE RLS permits this release to rewrite only its selected archive. The
-- constraint applies to all new/updated rows; runtime initialization lazily
-- rewrites other archives when each is opened. Global VALIDATE waits until an
-- operator has verified that no untouched legacy grants remain.

-- The prior release may still write an old role while a prepared migration is
-- waiting for activation. Store only a local grant; its legacy runtime_users
-- view continues to project owner admin until the new binary takes over.
CREATE OR REPLACE FUNCTION normalize_archive_member_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IN ('admin','researcher') THEN NEW.role := 'relative'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS normalize_archive_member_role_before_write ON archive_memberships;
CREATE TRIGGER normalize_archive_member_role_before_write
  BEFORE INSERT OR UPDATE ON archive_memberships
  FOR EACH ROW EXECUTE FUNCTION normalize_archive_member_role();

-- Keep the preceding release's runtime_users.role contract for archive
-- owners. New code reads tree_role/global_role/archive_owner explicitly.
CREATE OR REPLACE VIEW runtime_users WITH (security_invoker=true) AS
 SELECT a.id,a.name,a.created_at,a.last_visit_at,
        CASE WHEN o.user_id IS NOT NULL THEN 'admin'
             WHEN m.role='relative' AND pr.account_id IS NOT NULL THEN 'researcher'
             ELSE m.role END AS role,
        m.approved::integer AS approved,m.person_id,m.tree_access,
        m.role AS tree_role,
        CASE WHEN pa.account_id IS NOT NULL THEN 'admin'
             WHEN pr.account_id IS NOT NULL THEN 'researcher'
             ELSE NULL END AS global_role,
        (o.user_id IS NOT NULL) AS archive_owner
 FROM accounts a JOIN archive_memberships m ON m.user_id=a.id
 LEFT JOIN archive_owners o ON o.archive_id=m.archive_id AND o.user_id=m.user_id
 LEFT JOIN platform_admins pa ON pa.account_id=a.id
 LEFT JOIN platform_researchers pr ON pr.account_id=a.id;
