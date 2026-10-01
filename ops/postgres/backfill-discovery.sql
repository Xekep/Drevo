-- Run as the PostgreSQL administrator after 024_discovery_people.sql has
-- been installed. The endpoint remains unavailable until this commits.
BEGIN;
LOCK TABLE people, published_people IN SHARE MODE;
-- Newer catalogs have an opt-in relative projection referencing this table.
-- Truncate it explicitly; CASCADE could silently remove unrelated future data.
DO $$
BEGIN
  IF to_regclass('discovery_relative_names') IS NOT NULL THEN
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
UPDATE discovery_index_state SET ready=true WHERE singleton=true;
COMMIT;
