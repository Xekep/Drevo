-- Run as the PostgreSQL administrator after 024_discovery_people.sql has
-- been installed. The endpoint remains unavailable until this commits.
BEGIN;
LOCK TABLE people, published_people IN SHARE MODE;
-- Newer catalogs have opt-in projections referencing this table. Truncate
-- them explicitly; CASCADE could silently remove unrelated future data.
DO $$
BEGIN
  IF to_regclass('discovery_relative_names') IS NOT NULL
      AND to_regclass('discovery_linked_pairs') IS NOT NULL THEN
    EXECUTE 'TRUNCATE discovery_linked_pairs, discovery_relative_names, discovery_people';
  ELSIF to_regclass('discovery_linked_pairs') IS NOT NULL THEN
    EXECUTE 'TRUNCATE discovery_linked_pairs, discovery_people';
  ELSIF to_regclass('discovery_relative_names') IS NOT NULL THEN
    EXECUTE 'TRUNCATE discovery_relative_names, discovery_people';
  ELSE
    EXECUTE 'TRUNCATE discovery_people';
  END IF;
END $$;
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT archive_id,person_id FROM published_people LOOP
    PERFORM set_config('drevo.archive_id', entry.archive_id, true);
    PERFORM refresh_discovery_person(entry.archive_id, entry.person_id);
  END LOOP;
END $$;
-- Backfill the small public link projection after both published endpoints
-- have been rebuilt. Keep the endpoint unavailable until this commits.
DO $$
BEGIN
  IF to_regclass('discovery_linked_pairs') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO discovery_linked_pairs(
      left_archive_id,left_person_id,right_archive_id,right_person_id)
    SELECT m.left_archive_id,m.left_person_id,m.right_archive_id,m.right_person_id
      FROM discovery_match_requests m
      JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
      JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
     WHERE m.status='linked' ON CONFLICT DO NOTHING$sql$;
  END IF;
END $$;
UPDATE discovery_index_state SET ready=true WHERE singleton=true;
COMMIT;
