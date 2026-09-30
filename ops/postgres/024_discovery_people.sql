-- This table contains only fields that an archive administrator explicitly
-- published for discovery. It is deliberately readable across archive scopes;
-- private people and the source JSONB table retain their archive RLS policies.
CREATE TABLE IF NOT EXISTS discovery_people (
  archive_id text NOT NULL,
  person_id text NOT NULL,
  name text NOT NULL,
  birth_year text,
  death_year text,
  birth_place text,
  death_place text,
  publication_version text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', replace(lower(
      coalesce(name, '') || ' ' || coalesce(birth_year, '') || ' ' ||
      coalesce(death_year, '') || ' ' || coalesce(birth_place, '') || ' ' ||
      coalesce(death_place, '')), 'ё', 'е'))
  ) STORED,
  PRIMARY KEY (archive_id, person_id),
  FOREIGN KEY (archive_id, person_id)
    REFERENCES published_people(archive_id, person_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discovery_people_search
  ON discovery_people USING gin(search_vector);
CREATE INDEX IF NOT EXISTS discovery_people_order
  ON discovery_people(name,archive_id,person_id);
CREATE TABLE IF NOT EXISTS discovery_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ready boolean NOT NULL DEFAULT false
);
INSERT INTO discovery_index_state(singleton,ready) VALUES(true,false)
  ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION refresh_discovery_person(
  target_archive text, target_person text
) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  person_data jsonb;
  published_version text;
BEGIN
  SELECT p.data, published.published_at
    INTO person_data, published_version
    FROM published_people published
    JOIN people p ON p.archive_id=published.archive_id
                 AND p.id=published.person_id
   WHERE published.archive_id=target_archive
     AND published.person_id=target_person;
  IF NOT FOUND OR NOT (
    coalesce(person_data->>'deceased' = 'true', false) OR
    nullif(person_data->>'death', '') IS NOT NULL
  ) THEN
    DELETE FROM discovery_people
     WHERE archive_id=target_archive AND person_id=target_person;
    RETURN;
  END IF;
  INSERT INTO discovery_people(
    archive_id, person_id, name, birth_year, death_year,
    birth_place, death_place, publication_version
  ) VALUES (
    target_archive,
    target_person,
    btrim(concat_ws(' ', nullif(btrim(person_data->>'surname'), ''),
                         nullif(btrim(person_data->>'name'), ''),
                         nullif(btrim(person_data->>'patronymic'), ''))),
    substring(person_data->>'birth' from '[0-9]{4}'),
    substring(person_data->>'death' from '[0-9]{4}'),
    nullif(person_data->>'birthPlace', ''),
    nullif(person_data->>'deathPlace', ''),
    published_version
  ) ON CONFLICT (archive_id, person_id) DO UPDATE SET
    name=excluded.name,
    birth_year=excluded.birth_year,
    death_year=excluded.death_year,
    birth_place=excluded.birth_place,
    death_place=excluded.death_place,
    publication_version=excluded.publication_version;
END $$;

CREATE OR REPLACE FUNCTION refresh_discovery_after_publish()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM refresh_discovery_person(NEW.archive_id, NEW.person_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS refresh_discovery_after_publish ON published_people;
CREATE TRIGGER refresh_discovery_after_publish
  AFTER INSERT OR UPDATE ON published_people
  FOR EACH ROW EXECUTE FUNCTION refresh_discovery_after_publish();

CREATE OR REPLACE FUNCTION refresh_discovery_after_person_edit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM published_people
     WHERE archive_id=NEW.archive_id AND person_id=NEW.id
  ) THEN
    PERFORM refresh_discovery_person(NEW.archive_id, NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS refresh_discovery_after_person_edit ON people;
CREATE TRIGGER refresh_discovery_after_person_edit
  AFTER UPDATE OF data ON people
  FOR EACH ROW EXECUTE FUNCTION refresh_discovery_after_person_edit();

-- Runtime migration runs in one archive scope. Other archives are backfilled
-- by the maintenance script before the global endpoint is enabled.
DO $$
DECLARE row record;
BEGIN
  FOR row IN SELECT archive_id,person_id FROM published_people LOOP
    PERFORM refresh_discovery_person(row.archive_id, row.person_id);
  END LOOP;
END $$;
