-- Keep only the former account ID so archived authorship can be redacted even
-- when the account left a tree before its profile was deleted. This is not a
-- login identity and contains no name, email or provider token.
CREATE TABLE IF NOT EXISTS deleted_account_tombstones (
  id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW runtime_visible_audit_entries WITH (security_invoker=true) AS
SELECT a.archive_id,a.id,a.at,
  CASE WHEN d.id IS NULL THEN a.actor_id ELSE 'deleted-account' END AS actor_id,
  CASE WHEN d.id IS NULL THEN a.actor_name ELSE 'Удалённый участник' END AS actor_name,
  a.action,a.entity,a.entity_id,a.label,a.revision,a.details
FROM archive_audit_entries a
LEFT JOIN deleted_account_tombstones d ON d.id=a.actor_id;

CREATE OR REPLACE VIEW runtime_visible_person_comments WITH (security_invoker=true) AS
SELECT c.archive_id,c.id,c.person_id,
  CASE WHEN d.id IS NULL THEN c.author_id ELSE 'deleted-account' END AS author_id,
  CASE WHEN d.id IS NULL THEN c.author_name ELSE 'Удалённый участник' END AS author_name,
  c.created_ms,c.text
FROM person_comments c
LEFT JOIN deleted_account_tombstones d ON d.id=c.author_id;

CREATE OR REPLACE VIEW runtime_visible_share_links WITH (security_invoker=true) AS
SELECT s.archive_id,s.id,s.token_hash,s.title,s.anchor_id,s.person_ids,
  s.created_at,s.expires_at,
  CASE WHEN d.id IS NULL THEN s.created_by ELSE 'deleted-account' END AS created_by,
  CASE WHEN d.id IS NULL THEN s.created_name ELSE 'Удалённый участник' END AS created_name,
  COALESCE(s.revoked_at,CASE WHEN d.id IS NOT NULL THEN
    to_char(d.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) AS revoked_at,
  s.ordinal
FROM share_links s
LEFT JOIN deleted_account_tombstones d ON d.id=s.created_by;

CREATE OR REPLACE VIEW runtime_visible_research_suggestions WITH (security_invoker=true) AS
SELECT s.archive_id,s.id,s.kind,s.status,s.person_id,s.payload,s.reason,
  s.evidence,s.base_revision,s.created_at,
  CASE WHEN creator.id IS NULL THEN s.created_by ELSE 'deleted-account' END AS created_by,
  s.reviewed_at,
  CASE WHEN reviewer.id IS NULL THEN s.reviewed_by ELSE 'deleted-account' END AS reviewed_by
FROM research_suggestions s
LEFT JOIN deleted_account_tombstones creator ON creator.id=s.created_by
LEFT JOIN deleted_account_tombstones reviewer ON reviewer.id=s.reviewed_by;
