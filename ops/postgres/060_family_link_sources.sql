ALTER TABLE relations ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_sources_array;
ALTER TABLE relations ADD CONSTRAINT relations_sources_array
  CHECK (jsonb_typeof(sources) = 'array');
