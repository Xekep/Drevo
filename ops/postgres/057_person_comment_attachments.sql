-- Private attachment metadata shares the comment's archive RLS policy.
ALTER TABLE person_comments ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE person_comments DROP CONSTRAINT IF EXISTS person_comments_text_check;
ALTER TABLE person_comments ADD CONSTRAINT person_comments_text_check CHECK (
  char_length(text) BETWEEN 0 AND 2000 AND jsonb_typeof(attachments)='array'
  AND jsonb_array_length(attachments)<=8
  AND (length(btrim(text))>0 OR jsonb_array_length(attachments)>0)
);
CREATE OR REPLACE VIEW runtime_visible_person_comments WITH (security_invoker=true) AS
SELECT c.archive_id,c.id,c.person_id,
  CASE WHEN d.id IS NULL THEN c.author_id ELSE 'deleted-account' END AS author_id,
  CASE WHEN d.id IS NULL THEN c.author_name ELSE 'Удалённый участник' END AS author_name,
  c.created_ms,c.text,c.updated_ms,c.attachments
FROM person_comments c LEFT JOIN deleted_account_tombstones d ON d.id=c.author_id;
