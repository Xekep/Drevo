-- Read receipts refer to existing audit events; no per-recipient event copies.
CREATE TABLE IF NOT EXISTS archive_notification_cursors (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id',true)
    REFERENCES archives(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  read_through bigint NOT NULL DEFAULT 0 CHECK(read_through>=0),
  PRIMARY KEY(archive_id,user_id),
  FOREIGN KEY(archive_id,user_id) REFERENCES archive_memberships(archive_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS archive_notification_reads (
  archive_id text NOT NULL DEFAULT current_setting('drevo.archive_id',true),
  user_id text NOT NULL,
  event_id bigint NOT NULL,
  PRIMARY KEY(archive_id,user_id,event_id),
  FOREIGN KEY(archive_id,user_id) REFERENCES archive_memberships(archive_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(archive_id,event_id) REFERENCES archive_audit_entries(archive_id,id) ON DELETE CASCADE
);
ALTER TABLE archive_notification_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_notification_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON archive_notification_cursors;
CREATE POLICY archive_scope ON archive_notification_cursors
  USING(archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK(archive_id=current_setting('drevo.archive_id',true));
ALTER TABLE archive_notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_notification_reads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON archive_notification_reads;
CREATE POLICY archive_scope ON archive_notification_reads
  USING(archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK(archive_id=current_setting('drevo.archive_id',true));
CREATE INDEX IF NOT EXISTS archive_notification_events
  ON archive_audit_entries(archive_id,id DESC)
  WHERE (entity='people' AND action='Добавлено') OR
    (entity='person_comment' AND action='Добавлено сообщение в обсуждение');
