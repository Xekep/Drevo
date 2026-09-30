-- A validated account session may list only its own memberships across
-- archives. The account context is transaction-local; write policies remain
-- bound to drevo.archive_id.
DROP POLICY IF EXISTS account_memberships_read ON archive_memberships;
CREATE POLICY account_memberships_read ON archive_memberships
  FOR SELECT USING (user_id = current_setting('drevo.account_id', true));

DROP POLICY IF EXISTS account_archives_read ON archives;
CREATE POLICY account_archives_read ON archives
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM archive_memberships m
      WHERE m.archive_id = archives.id
        AND m.user_id = current_setting('drevo.account_id', true)
    )
  );
