-- A basic account owns at most one tree. Membership in other trees is separate.
CREATE UNIQUE INDEX IF NOT EXISTS archive_owners_one_tree_per_user
  ON archive_owners(user_id);
