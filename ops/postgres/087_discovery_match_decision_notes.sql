-- The responding owner may attach one explanation to the original decision.
-- Keep it outside the request row: request audit remains readable after a
-- publication is withdrawn, while this free text must then become invisible.
ALTER TABLE discovery_match_requests ADD COLUMN decision_txid bigint;
-- A participant can UPDATE a request under its existing RLS policy. Prevent a
-- later transaction from minting a fresh decision_txid to append a note.
CREATE FUNCTION guard_discovery_match_decision_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.decision_txid IS NOT NULL THEN
      RAISE EXCEPTION 'decision note transaction requires a reviewed decision'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('linked','rejected','revoked') AND NEW.status='pending' THEN
    RAISE EXCEPTION 'a terminal match cannot be reopened for a decision note'
      USING ERRCODE='42501';
  END IF;
  IF NEW.decision_txid IS DISTINCT FROM OLD.decision_txid AND NOT (
    OLD.status='pending' AND OLD.decision_txid IS NULL
    AND NEW.status IN ('linked','rejected')
    AND NEW.decision_txid=txid_current()
    AND OLD.initiated_by_archive_id<>current_setting('drevo.archive_id',true)
    AND (OLD.left_archive_id=current_setting('drevo.archive_id',true)
      OR OLD.right_archive_id=current_setting('drevo.archive_id',true))
  ) THEN
    RAISE EXCEPTION 'decision note transaction cannot be changed' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_discovery_match_decision_txid
  BEFORE INSERT OR UPDATE ON discovery_match_requests FOR EACH ROW
  EXECUTE FUNCTION guard_discovery_match_decision_txid();
CREATE TABLE discovery_match_decision_notes (
  match_id text PRIMARY KEY REFERENCES discovery_match_requests(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (note=btrim(note) AND char_length(note) BETWEEN 1 AND 500),
  left_publication_version text NOT NULL,
  right_publication_version text NOT NULL
);
ALTER TABLE discovery_match_decision_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_match_decision_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_match_decision_notes_read ON discovery_match_decision_notes
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM discovery_match_requests m
    JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
    JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
    WHERE m.id=match_id AND m.status IN ('linked','rejected')
      AND l.publication_version=discovery_match_decision_notes.left_publication_version
      AND r.publication_version=discovery_match_decision_notes.right_publication_version
      AND (m.left_archive_id=current_setting('drevo.archive_id',true)
        OR m.right_archive_id=current_setting('drevo.archive_id',true))
  ));
CREATE POLICY discovery_match_decision_notes_insert ON discovery_match_decision_notes
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM discovery_match_requests m
    JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
    JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
    WHERE m.id=match_id AND m.status IN ('linked','rejected')
      AND m.decision_txid=txid_current()
      AND l.publication_version=discovery_match_decision_notes.left_publication_version
      AND r.publication_version=discovery_match_decision_notes.right_publication_version
      AND m.initiated_by_archive_id<>current_setting('drevo.archive_id',true)
      AND (m.left_archive_id=current_setting('drevo.archive_id',true)
        OR m.right_archive_id=current_setting('drevo.archive_id',true))
  ));
