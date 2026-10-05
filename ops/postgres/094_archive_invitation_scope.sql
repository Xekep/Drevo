-- Invitation grants remain archive-local; no global role or account changes.
ALTER TABLE archive_invitations
  ADD COLUMN IF NOT EXISTS person_id text,
  ADD COLUMN IF NOT EXISTS tree_access text NOT NULL DEFAULT 'all';
ALTER TABLE archive_invitations
  ADD CONSTRAINT archive_invitation_scope_check CHECK (
    tree_access IN ('all','common_ancestors') AND
    (tree_access='all' OR person_id IS NOT NULL)
  );
