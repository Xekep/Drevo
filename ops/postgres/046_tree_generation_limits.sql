ALTER TABLE user_tree_preferences
  ADD COLUMN IF NOT EXISTS generation_limits text
  CHECK (generation_limits IS NULL OR jsonb_typeof(generation_limits::jsonb)='object');
