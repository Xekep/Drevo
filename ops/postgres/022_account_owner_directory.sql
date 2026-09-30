-- OAuth may find an account's existing personal tree without seeing other
-- owners. The transaction-local account context does not grant writes.
DROP POLICY IF EXISTS account_owners_read ON archive_owners;
CREATE POLICY account_owners_read ON archive_owners
  FOR SELECT USING (user_id = current_setting('drevo.account_id', true));
