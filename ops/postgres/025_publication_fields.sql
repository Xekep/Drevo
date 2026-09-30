-- Existing publications retain their previously visible years and places.
-- Birth surnames were never public and remain hidden until explicitly selected.
ALTER TABLE published_people ADD COLUMN IF NOT EXISTS birth_year_visible boolean NOT NULL DEFAULT true;
ALTER TABLE published_people ADD COLUMN IF NOT EXISTS death_year_visible boolean NOT NULL DEFAULT true;
ALTER TABLE published_people ADD COLUMN IF NOT EXISTS birth_place_visible boolean NOT NULL DEFAULT true;
ALTER TABLE published_people ADD COLUMN IF NOT EXISTS death_place_visible boolean NOT NULL DEFAULT true;
ALTER TABLE published_people ADD COLUMN IF NOT EXISTS birth_surname_visible boolean NOT NULL DEFAULT false;
ALTER TABLE discovery_people ADD COLUMN IF NOT EXISTS birth_surname text;
DROP INDEX IF EXISTS discovery_people_search;
ALTER TABLE discovery_people DROP COLUMN search_vector;
ALTER TABLE discovery_people ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', replace(lower(
    coalesce(name, '') || ' ' || coalesce(birth_surname, '') || ' ' ||
    coalesce(birth_year, '') || ' ' || coalesce(death_year, '') || ' ' ||
    coalesce(birth_place, '') || ' ' || coalesce(death_place, '')), 'ё', 'е'))
) STORED;
CREATE INDEX discovery_people_search ON discovery_people USING gin(search_vector);

CREATE OR REPLACE FUNCTION refresh_discovery_person(
  target_archive text, target_person text
) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  person_data jsonb;
  visible_birth_surname boolean;
  visible_birth_year boolean;
  visible_death_year boolean;
  visible_birth_place boolean;
  visible_death_place boolean;
  published_version text;
BEGIN
  SELECT p.data, published.birth_surname_visible,
         published.birth_year_visible, published.death_year_visible,
         published.birth_place_visible, published.death_place_visible,
         published.published_at
    INTO person_data, visible_birth_surname, visible_birth_year,
         visible_death_year, visible_birth_place, visible_death_place,
         published_version
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
    archive_id, person_id, name, birth_surname, birth_year, death_year,
    birth_place, death_place, publication_version
  ) VALUES (
    target_archive,
    target_person,
    btrim(concat_ws(' ', nullif(btrim(person_data->>'surname'), ''),
                         nullif(btrim(person_data->>'name'), ''),
                         nullif(btrim(person_data->>'patronymic'), ''))),
    CASE WHEN visible_birth_surname THEN nullif(person_data->>'maidenName', '') END,
    CASE WHEN visible_birth_year THEN substring(person_data->>'birth' from '[0-9]{4}') END,
    CASE WHEN visible_death_year THEN substring(person_data->>'death' from '[0-9]{4}') END,
    CASE WHEN visible_birth_place THEN nullif(person_data->>'birthPlace', '') END,
    CASE WHEN visible_death_place THEN nullif(person_data->>'deathPlace', '') END,
    published_version
  ) ON CONFLICT (archive_id, person_id) DO UPDATE SET
    name=excluded.name,
    birth_surname=excluded.birth_surname,
    birth_year=excluded.birth_year,
    death_year=excluded.death_year,
    birth_place=excluded.birth_place,
    death_place=excluded.death_place,
    publication_version=excluded.publication_version;
END $$;
