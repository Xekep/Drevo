-- Existing branch consents retain their original until-revoked meaning (NULL).
-- New HTTP grants always set a finite expiry. Keep the member RLS gate in the
-- database: an expired source grant must not remain readable through SQL.
ALTER TABLE discovery_branch_grants
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

DROP POLICY IF EXISTS discovery_branch_members_read ON discovery_branch_members;
CREATE POLICY discovery_branch_members_read ON discovery_branch_members FOR SELECT
  USING (grantor_archive_id=current_setting('drevo.archive_id',true)
    OR ((left_archive_id=current_setting('drevo.archive_id',true)
      OR right_archive_id=current_setting('drevo.archive_id',true))
      AND EXISTS (SELECT 1 FROM discovery_branch_grants source_grant
        WHERE source_grant.left_archive_id=discovery_branch_members.left_archive_id
          AND source_grant.left_person_id=discovery_branch_members.left_person_id
          AND source_grant.right_archive_id=discovery_branch_members.right_archive_id
          AND source_grant.right_person_id=discovery_branch_members.right_person_id
          AND source_grant.grantor_archive_id=discovery_branch_members.grantor_archive_id
          AND (source_grant.expires_at IS NULL OR source_grant.expires_at>now()))
      AND EXISTS (SELECT 1 FROM discovery_branch_grants own_grant
        WHERE own_grant.left_archive_id=discovery_branch_members.left_archive_id
          AND own_grant.left_person_id=discovery_branch_members.left_person_id
          AND own_grant.right_archive_id=discovery_branch_members.right_archive_id
          AND own_grant.right_person_id=discovery_branch_members.right_person_id
          AND own_grant.grantor_archive_id=current_setting('drevo.archive_id',true)
          AND (own_grant.expires_at IS NULL OR own_grant.expires_at>now()))));
