-- Existing scalar consents keep their until-revoked meaning (NULL).
-- New HTTP grants have a finite term. Expired snapshots must not be readable
-- by the recipient through direct SQL, including copy-preview/apply paths.
ALTER TABLE discovery_linked_card_grants
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

DROP POLICY IF EXISTS discovery_linked_card_read ON discovery_linked_card_grants;
CREATE POLICY discovery_linked_card_read ON discovery_linked_card_grants FOR SELECT
  USING (grantor_archive_id=current_setting('drevo.archive_id',true)
    OR ((left_archive_id=current_setting('drevo.archive_id',true)
      OR right_archive_id=current_setting('drevo.archive_id',true))
      AND (expires_at IS NULL OR expires_at>now())));
