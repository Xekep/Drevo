-- A match joins two published identity projections. It never grants archive
-- membership, access to family branches, or permission to copy private data.
CREATE TABLE IF NOT EXISTS discovery_match_requests (
  id text PRIMARY KEY,
  left_archive_id text NOT NULL,
  left_person_id text NOT NULL,
  right_archive_id text NOT NULL,
  right_person_id text NOT NULL,
  initiated_by_archive_id text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','linked','rejected','revoked')),
  responded_by text,
  responded_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  CHECK ((left_archive_id COLLATE "C",left_person_id COLLATE "C")
       < (right_archive_id COLLATE "C",right_person_id COLLATE "C")),
  CHECK (initiated_by_archive_id IN (left_archive_id,right_archive_id)),
  UNIQUE (left_archive_id,left_person_id,right_archive_id,right_person_id)
);
CREATE INDEX IF NOT EXISTS discovery_matches_left
  ON discovery_match_requests(left_archive_id,requested_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS discovery_matches_right
  ON discovery_match_requests(right_archive_id,requested_at DESC,id DESC);
ALTER TABLE discovery_match_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_match_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS participant_scope ON discovery_match_requests;
CREATE POLICY participant_scope ON discovery_match_requests
  USING (left_archive_id=current_setting('drevo.archive_id',true)
      OR right_archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK (left_archive_id=current_setting('drevo.archive_id',true)
           OR right_archive_id=current_setting('drevo.archive_id',true));

CREATE OR REPLACE FUNCTION revoke_discovery_matches_after_unpublish()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE discovery_match_requests SET status='revoked',
    revoked_by='system',revoked_at=now()
   WHERE status IN ('pending','linked')
     AND ((left_archive_id=OLD.archive_id AND left_person_id=OLD.person_id)
       OR (right_archive_id=OLD.archive_id AND right_person_id=OLD.person_id));
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS revoke_discovery_matches_after_unpublish ON discovery_people;
CREATE TRIGGER revoke_discovery_matches_after_unpublish
  AFTER DELETE ON discovery_people FOR EACH ROW
  EXECUTE FUNCTION revoke_discovery_matches_after_unpublish();
