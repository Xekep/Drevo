-- Additive metadata: existing comments retain their original creation time.
ALTER TABLE person_comments ADD COLUMN IF NOT EXISTS updated_ms bigint
  CHECK (updated_ms IS NULL OR updated_ms > created_ms);

-- Append the column so existing readers and view grants remain compatible.
CREATE OR REPLACE VIEW runtime_visible_person_comments WITH (security_invoker=true) AS
SELECT c.archive_id,c.id,c.person_id,
  CASE WHEN d.id IS NULL THEN c.author_id ELSE 'deleted-account' END AS author_id,
  CASE WHEN d.id IS NULL THEN c.author_name ELSE 'Удалённый участник' END AS author_name,
  c.created_ms,c.text,c.updated_ms
FROM person_comments c
LEFT JOIN deleted_account_tombstones d ON d.id=c.author_id;
