ALTER TABLE user_tree_preferences
  ADD COLUMN IF NOT EXISTS fragment_threshold integer
  CHECK (fragment_threshold IS NULL OR fragment_threshold=0 OR fragment_threshold BETWEEN 100 AND 10000);
