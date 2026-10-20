CREATE TABLE IF NOT EXISTS personal_bookmarks (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id',true) REFERENCES archives(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('person','photo','document')),
  entity_id text NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 200),
  created_ms bigint NOT NULL,
  PRIMARY KEY(archive_id,user_id,kind,entity_id),
  FOREIGN KEY(archive_id,user_id) REFERENCES archive_memberships(archive_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_people_filters (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id',true) REFERENCES archives(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  criteria jsonb NOT NULL,
  created_ms bigint NOT NULL,
  PRIMARY KEY(archive_id,user_id,id),
  FOREIGN KEY(archive_id,user_id) REFERENCES archive_memberships(archive_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_reverts (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id',true) REFERENCES archives(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK(revision>0),
  reverted_revision bigint NOT NULL CHECK(reverted_revision>revision),
  PRIMARY KEY(archive_id,revision)
);
ALTER TABLE personal_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_bookmarks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON personal_bookmarks;
CREATE POLICY archive_scope ON personal_bookmarks
  USING(archive_id=current_setting('drevo.archive_id',true) AND user_id=current_setting('drevo.account_id',true))
  WITH CHECK(archive_id=current_setting('drevo.archive_id',true) AND user_id=current_setting('drevo.account_id',true));
ALTER TABLE personal_people_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_people_filters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON personal_people_filters;
CREATE POLICY archive_scope ON personal_people_filters
  USING(archive_id=current_setting('drevo.archive_id',true) AND user_id=current_setting('drevo.account_id',true))
  WITH CHECK(archive_id=current_setting('drevo.archive_id',true) AND user_id=current_setting('drevo.account_id',true));
ALTER TABLE audit_reverts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_reverts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON audit_reverts;
CREATE POLICY archive_scope ON audit_reverts
  USING(archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK(archive_id=current_setting('drevo.archive_id',true));
