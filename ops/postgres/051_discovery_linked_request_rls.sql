-- Public cross-archive navigation now reads only discovery_linked_pairs.
-- Full match requests, including the reason and actors, remain visible to
-- their two participating archives through participant_scope alone.
DROP POLICY IF EXISTS linked_discovery_read ON discovery_match_requests;
