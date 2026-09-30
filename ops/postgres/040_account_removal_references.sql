-- Invitations and unaccepted transfers have no meaning after either account
-- disappears. Cascade these records rather than allowing an old reference to
-- prevent an account from being removed. A used invitation must disappear as
-- a whole: clearing only used_by would make it look unused again.
ALTER TABLE archive_invitations
  DROP CONSTRAINT IF EXISTS archive_invitations_created_by_fkey,
  DROP CONSTRAINT IF EXISTS archive_invitations_used_by_fkey;
ALTER TABLE archive_invitations
  ADD CONSTRAINT archive_invitations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT archive_invitations_used_by_fkey
    FOREIGN KEY (used_by) REFERENCES accounts(id) ON DELETE CASCADE;

ALTER TABLE archive_owner_transfers
  DROP CONSTRAINT IF EXISTS archive_owner_transfers_from_user_id_fkey,
  DROP CONSTRAINT IF EXISTS archive_owner_transfers_to_user_id_fkey;
ALTER TABLE archive_owner_transfers
  ADD CONSTRAINT archive_owner_transfers_from_user_id_fkey
    FOREIGN KEY (from_user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  ADD CONSTRAINT archive_owner_transfers_to_user_id_fkey
    FOREIGN KEY (to_user_id) REFERENCES accounts(id) ON DELETE CASCADE;
