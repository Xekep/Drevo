-- Both archive administrators confirmed these two published identities.
-- The link is visible to signed-in users through the discovery API, while
-- pending/rejected/revoked requests remain participant-only.
DROP POLICY IF EXISTS linked_discovery_read ON discovery_match_requests;
CREATE POLICY linked_discovery_read ON discovery_match_requests
  FOR SELECT USING (status='linked');
CREATE INDEX IF NOT EXISTS discovery_matches_left_person
  ON discovery_match_requests(left_archive_id,left_person_id,status);
CREATE INDEX IF NOT EXISTS discovery_matches_right_person
  ON discovery_match_requests(right_archive_id,right_person_id,status);
