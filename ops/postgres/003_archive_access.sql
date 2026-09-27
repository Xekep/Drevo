-- Typed account and archive access data, separate from the lossless SQLite
-- shadow rows. One account may later be a member of more than one archive.
CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at text NOT NULL,
  last_visit_at text
);

CREATE TABLE IF NOT EXISTS archive_memberships (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'relative', 'reader')),
  approved boolean NOT NULL,
  person_id text,
  tree_access text NOT NULL CHECK (tree_access IN ('all', 'common_ancestors')),
  PRIMARY KEY (archive_id, user_id),
  FOREIGN KEY (archive_id, person_id)
    REFERENCES people(archive_id, id) ON DELETE SET NULL (person_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS archive_memberships_person
  ON archive_memberships(archive_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS archive_memberships_list
  ON archive_memberships(archive_id, user_id);

CREATE TABLE IF NOT EXISTS archive_owners (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  FOREIGN KEY (archive_id, user_id)
    REFERENCES archive_memberships(archive_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_expiry
  ON account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS archive_access_settings (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  public_tree boolean NOT NULL,
  public_albums boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_tree_settings (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  reverse_timeline boolean NOT NULL
);
