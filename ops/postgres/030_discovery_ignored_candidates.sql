CREATE TABLE discovery_ignored_candidates (
  archive_id text NOT NULL,
  source_person_id text NOT NULL,
  target_archive_id text NOT NULL,
  target_person_id text NOT NULL,
  ignored_by text NOT NULL,
  ignored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archive_id,source_person_id,target_archive_id,target_person_id),
  FOREIGN KEY (archive_id,source_person_id)
    REFERENCES people(archive_id,id) ON DELETE CASCADE,
  FOREIGN KEY (target_archive_id,target_person_id)
    REFERENCES people(archive_id,id) ON DELETE CASCADE,
  CHECK (archive_id<>target_archive_id)
);
ALTER TABLE discovery_ignored_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_ignored_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON discovery_ignored_candidates
  USING (archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id',true));
