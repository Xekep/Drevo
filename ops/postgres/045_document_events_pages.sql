ALTER TABLE documents ADD COLUMN IF NOT EXISTS event_links text NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pages text NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'documents'::regclass AND conname = 'documents_event_links_array_check'
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_event_links_array_check
      CHECK (jsonb_typeof(event_links::jsonb) = 'array');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'documents'::regclass AND conname = 'documents_pages_array_check'
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_pages_array_check
      CHECK (jsonb_typeof(pages::jsonb) = 'array');
  END IF;
END $$;
