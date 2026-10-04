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
  IF to_regclass('discovery_relative_consents') IS NOT NULL THEN
    EXECUTE 'CREATE TEMP TABLE discovery_relative_consents_backup ON COMMIT DROP
      AS SELECT * FROM discovery_relative_consents';
    tables := tables || 'discovery_relative_consents,';
  END IF;
  IF to_regclass('discovery_grandparent_consents') IS NOT NULL THEN
    EXECUTE 'CREATE TEMP TABLE discovery_grandparent_consents_backup ON COMMIT DROP
      AS SELECT c.*,f.name AS focal_name,v.name AS via_name
      FROM discovery_grandparent_consents c
      JOIN discovery_people f ON f.archive_id=c.archive_id AND f.person_id=c.person_id
      JOIN discovery_people v ON v.archive_id=c.archive_id AND v.person_id=c.via_person_id';
    tables := tables || 'discovery_grandparent_consents,';
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
-- Recreate only previously consented edges whose two publications and exact
-- relation still exist. Never infer consent from two published people.
DO $$
BEGIN
  IF to_regclass('discovery_relative_consents') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO discovery_relative_consents
      (archive_id,person_id,relation_id,relative_person_id,kind,relative_name)
      SELECT b.archive_id,b.person_id,b.relation_id,b.relative_person_id,b.kind,
        relative.name
      FROM pg_temp.discovery_relative_consents_backup b
      JOIN relations r ON r.archive_id=b.archive_id AND r.id=b.relation_id
      JOIN discovery_people focal ON focal.archive_id=b.archive_id
        AND focal.person_id=b.person_id
      JOIN discovery_people relative ON relative.archive_id=b.archive_id
        AND relative.person_id=b.relative_person_id
      WHERE r.type IN ('parent','spouse') AND
        ((r.source=b.person_id AND r.target=b.relative_person_id)
          OR (r.target=b.person_id AND r.source=b.relative_person_id))
        AND b.kind=CASE WHEN r.type='spouse' THEN 'spouse'
          WHEN r.source=b.person_id THEN 'child' ELSE 'parent' END$sql$;
  END IF;
END $$;
-- Recreate only the same two-edge choice with the same three published
-- names. A rebuilt publication alone never opts an owner into a new clue.
DO $$
BEGIN
  IF to_regclass('discovery_grandparent_consents') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO discovery_grandparent_consents
      (archive_id,person_id,first_relation_id,second_relation_id,
        via_person_id,relative_person_id,relative_name)
      SELECT b.archive_id,b.person_id,b.first_relation_id,b.second_relation_id,
        b.via_person_id,b.relative_person_id,b.relative_name
      FROM pg_temp.discovery_grandparent_consents_backup b
      JOIN relations first_edge ON first_edge.archive_id=b.archive_id
        AND first_edge.id=b.first_relation_id AND first_edge.type='parent'
        AND first_edge.target=b.person_id AND first_edge.source=b.via_person_id
      JOIN relations second_edge ON second_edge.archive_id=b.archive_id
        AND second_edge.id=b.second_relation_id AND second_edge.type='parent'
        AND second_edge.target=b.via_person_id
        AND second_edge.source=b.relative_person_id
      JOIN discovery_people focal ON focal.archive_id=b.archive_id
        AND focal.person_id=b.person_id AND focal.name=b.focal_name
      JOIN discovery_people via ON via.archive_id=b.archive_id
        AND via.person_id=b.via_person_id AND via.name=b.via_name
      JOIN discovery_people relative ON relative.archive_id=b.archive_id
        AND relative.person_id=b.relative_person_id AND relative.name=b.relative_name$sql$;
  END IF;
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
