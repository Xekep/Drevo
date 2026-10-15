ALTER TABLE user_tree_preferences
  ADD COLUMN IF NOT EXISTS presentation text NOT NULL DEFAULT 'flat'
  CHECK (presentation IN ('flat','depth'));
