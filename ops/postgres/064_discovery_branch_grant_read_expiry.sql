-- The member policy already closes expired branches. Hide the grant row's
-- account ID and timestamps from the recipient too; the grantor may still
-- inspect or revoke its own expired consent. Legacy NULL grants remain active.
DROP POLICY IF EXISTS discovery_branch_grants_read ON discovery_branch_grants;
CREATE POLICY discovery_branch_grants_read ON discovery_branch_grants FOR SELECT
  USING (grantor_archive_id=current_setting('drevo.archive_id',true)
    OR ((left_archive_id=current_setting('drevo.archive_id',true)
      OR right_archive_id=current_setting('drevo.archive_id',true))
      AND (expires_at IS NULL OR expires_at>now())));
