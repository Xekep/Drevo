-- Preserve access for the administrators of the original archive exactly once.
-- Later archive owners/admins are never promoted by their per-tree role.
CREATE TABLE IF NOT EXISTS platform_admins (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_admins(account_id)
SELECT DISTINCT user_id
  FROM archive_memberships
 WHERE archive_id=current_setting('drevo.archive_id', true)
   AND role='admin' AND approved
ON CONFLICT (account_id) DO NOTHING;
