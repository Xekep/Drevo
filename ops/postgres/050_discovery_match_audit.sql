-- Audit only visible publication revisions, never private person data.
ALTER TABLE discovery_match_requests
  ADD COLUMN IF NOT EXISTS request_review_token text
    CHECK (request_review_token ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS decision_review_token text
    CHECK (decision_review_token ~ '^[0-9a-f]{64}$');

-- The next release will restrict full linked requests to participants. First
-- move public reads to keys-only rows while the previous release still uses
-- the old policy for rollback compatibility. Foreign keys
-- remove a transition in the same transaction as either unpublication.
CREATE TABLE IF NOT EXISTS discovery_linked_pairs (
  left_archive_id text NOT NULL,
  left_person_id text NOT NULL,
  right_archive_id text NOT NULL,
  right_person_id text NOT NULL,
  PRIMARY KEY (left_archive_id,left_person_id,right_archive_id,right_person_id),
  FOREIGN KEY (left_archive_id,left_person_id)
    REFERENCES discovery_people(archive_id,person_id) ON DELETE CASCADE,
  FOREIGN KEY (right_archive_id,right_person_id)
    REFERENCES discovery_people(archive_id,person_id) ON DELETE CASCADE,
  FOREIGN KEY (left_archive_id,left_person_id,right_archive_id,right_person_id)
    REFERENCES discovery_match_requests(
      left_archive_id,left_person_id,right_archive_id,right_person_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discovery_linked_pairs_right
  ON discovery_linked_pairs(right_archive_id,right_person_id);

CREATE OR REPLACE FUNCTION sync_discovery_linked_pair()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  DELETE FROM discovery_linked_pairs
   WHERE left_archive_id=NEW.left_archive_id AND left_person_id=NEW.left_person_id
     AND right_archive_id=NEW.right_archive_id AND right_person_id=NEW.right_person_id;
  IF NEW.status='linked' THEN
    INSERT INTO discovery_linked_pairs(
      left_archive_id,left_person_id,right_archive_id,right_person_id)
    VALUES(NEW.left_archive_id,NEW.left_person_id,NEW.right_archive_id,NEW.right_person_id);
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='discovery_match_requests'::regclass
        AND tgname='sync_discovery_linked_pair') THEN
    CREATE TRIGGER sync_discovery_linked_pair
      AFTER INSERT OR UPDATE OF status ON discovery_match_requests
      FOR EACH ROW EXECUTE FUNCTION sync_discovery_linked_pair();
  END IF;
END $$;

INSERT INTO discovery_linked_pairs(
  left_archive_id,left_person_id,right_archive_id,right_person_id)
SELECT m.left_archive_id,m.left_person_id,m.right_archive_id,m.right_person_id
  FROM discovery_match_requests m
  JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
  JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
 WHERE m.status='linked'
ON CONFLICT DO NOTHING;
