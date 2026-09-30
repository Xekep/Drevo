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

-- Account sessions are global. Losing one membership must not sign the
-- account out of every other archive.
CREATE OR REPLACE FUNCTION runtime_member_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM ai_chats WHERE archive_id=OLD.archive_id AND user_id=OLD.user_id;
 RETURN OLD;
END $$;
