-- A provider may register again with the same account ID after deletion.
-- Old comments have already been physically anonymized during deletion; a
-- tombstone must not hide the new account's comments or its edit rights.
CREATE OR REPLACE VIEW runtime_visible_person_comments WITH (security_invoker=true) AS
SELECT c.archive_id,c.id,c.person_id,
  CASE WHEN d.id IS NULL OR a.id IS NOT NULL THEN c.author_id ELSE 'deleted-account' END AS author_id,
  CASE WHEN d.id IS NULL OR a.id IS NOT NULL THEN c.author_name ELSE 'Удалённый участник' END AS author_name,
  c.created_ms,c.text,c.updated_ms,c.attachments
FROM person_comments c
LEFT JOIN deleted_account_tombstones d ON d.id=c.author_id
LEFT JOIN accounts a ON a.id=c.author_id;
