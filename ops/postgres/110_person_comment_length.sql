-- Preserve authorship, attachments and optimistic edit versions while raising
-- the text limit. Installing this constraint is safe to repeat.
ALTER TABLE person_comments DROP CONSTRAINT IF EXISTS person_comments_text_check;
ALTER TABLE person_comments ADD CONSTRAINT person_comments_text_check CHECK (
  char_length(text) BETWEEN 0 AND 4000 AND jsonb_typeof(attachments)='array'
  AND jsonb_array_length(attachments)<=8
  AND (length(btrim(text))>0 OR jsonb_array_length(attachments)>0)
);
