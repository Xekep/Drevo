-- Run as the PostgreSQL administrator after 024_discovery_people.sql has
-- been installed. The endpoint remains unavailable until this commits.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user
      AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Discovery backfill requires a role that bypasses RLS';
  END IF;
END $$;
LOCK TABLE people, published_people IN SHARE MODE;
-- Newer catalogs have opt-in projections referencing this table. Truncate
-- them explicitly; CASCADE could silently remove unrelated future data.
DO $$
DECLARE tables text := '';
BEGIN
  IF to_regclass('discovery_branch_members') IS NOT NULL THEN
    EXECUTE 'CREATE TEMP TABLE discovery_branch_members_backup ON COMMIT DROP
      AS SELECT * FROM discovery_branch_members';
    tables := tables || 'discovery_branch_members,';
  END IF;
  IF to_regclass('discovery_branch_grants') IS NOT NULL THEN
    EXECUTE 'CREATE TEMP TABLE discovery_branch_grants_backup ON COMMIT DROP
      AS SELECT * FROM discovery_branch_grants';
    tables := tables || 'discovery_branch_grants,';
  END IF;
  IF to_regclass('discovery_linked_card_grants') IS NOT NULL THEN
    EXECUTE 'CREATE TEMP TABLE discovery_card_grants_backup ON COMMIT DROP
      AS SELECT * FROM discovery_linked_card_grants';
    tables := tables || 'discovery_linked_card_grants,';
  END IF;
  IF to_regclass('discovery_linked_pairs') IS NOT NULL THEN
    tables := tables || 'discovery_linked_pairs,';
  END IF;
  IF to_regclass('discovery_relative_names') IS NOT NULL THEN
    tables := tables || 'discovery_relative_names,';
  END IF;
  EXECUTE 'TRUNCATE ' || tables || 'discovery_people';
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
-- Preserve only grants whose confirmed published pair was rebuilt.
DO $$
BEGIN
  IF to_regclass('discovery_linked_card_grants') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO discovery_linked_card_grants
      SELECT backup.* FROM pg_temp.discovery_card_grants_backup backup
      JOIN discovery_linked_pairs pair
        ON pair.left_archive_id=backup.left_archive_id
       AND pair.left_person_id=backup.left_person_id
       AND pair.right_archive_id=backup.right_archive_id
       AND pair.right_person_id=backup.right_person_id$sql$;
  END IF;
END $$;
-- Restore bilateral branch consent only for pairs and published members that
-- still exist. There is never a temporary broad grant during the backfill.
DO $$
BEGIN
  IF to_regclass('discovery_branch_grants') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO discovery_branch_grants
      SELECT backup.* FROM pg_temp.discovery_branch_grants_backup backup
      JOIN discovery_linked_pairs pair
        ON pair.left_archive_id=backup.left_archive_id
       AND pair.left_person_id=backup.left_person_id
       AND pair.right_archive_id=backup.right_archive_id
       AND pair.right_person_id=backup.right_person_id$sql$;
    EXECUTE $sql$INSERT INTO discovery_branch_members
      SELECT backup.* FROM pg_temp.discovery_branch_members_backup backup
      JOIN discovery_branch_grants grant_row
        ON grant_row.left_archive_id=backup.left_archive_id
       AND grant_row.left_person_id=backup.left_person_id
       AND grant_row.right_archive_id=backup.right_archive_id
       AND grant_row.right_person_id=backup.right_person_id
       AND grant_row.grantor_archive_id=backup.grantor_archive_id
      JOIN discovery_people person ON person.archive_id=backup.grantor_archive_id
        AND person.person_id=backup.person_id$sql$;
  END IF;
END $$;
UPDATE discovery_index_state SET ready=true WHERE singleton=true;
COMMIT;
