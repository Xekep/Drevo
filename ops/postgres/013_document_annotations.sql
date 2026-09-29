ALTER TABLE IF EXISTS documents ADD COLUMN IF NOT EXISTS annotations text NOT NULL
  DEFAULT '[]' CHECK (jsonb_typeof(annotations::jsonb) = 'array');
