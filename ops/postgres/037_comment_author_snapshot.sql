-- Preserve the author's displayed name when a personal archive is transferred.
-- Account IDs in imported archives need not refer to local accounts.
ALTER TABLE person_comments ADD COLUMN IF NOT EXISTS author_name text NOT NULL DEFAULT '';
