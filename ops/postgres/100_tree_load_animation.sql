ALTER TABLE user_tree_preferences
  ADD COLUMN IF NOT EXISTS animate_on_load bigint NOT NULL DEFAULT 1
  CHECK (animate_on_load IN (0,1));
