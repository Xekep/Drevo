-- The public full name alone cannot identify the given-name boundary when a
-- published surname contains spaces or a hyphen. These are components of the
-- already consented name, not additional discoverable person fields.
-- Keep the metadata-only DDL from waiting behind a long-running writer.
SET LOCAL lock_timeout = '5s';
ALTER TABLE discovery_people
  ADD COLUMN IF NOT EXISTS surname_part text,
  ADD COLUMN IF NOT EXISTS given_part text;

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
    archive_id, person_id, name, surname_part, given_part,
    birth_surname, birth_year, death_year,
    birth_place, death_place, publication_version
  ) VALUES (
    target_archive,
    target_person,
    btrim(concat_ws(' ', nullif(btrim(person_data->>'surname'), ''),
                         nullif(btrim(person_data->>'name'), ''),
                         nullif(btrim(person_data->>'patronymic'), ''))),
    coalesce(btrim(person_data->>'surname'), ''),
    coalesce(btrim(person_data->>'name'), ''),
    CASE WHEN visible_birth_surname THEN nullif(person_data->>'maidenName', '') END,
    CASE WHEN visible_birth_year THEN substring(person_data->>'birth' from '[0-9]{4}') END,
    CASE WHEN visible_death_year THEN substring(person_data->>'death' from '[0-9]{4}') END,
    CASE WHEN visible_birth_place THEN nullif(person_data->>'birthPlace', '') END,
    CASE WHEN visible_death_place THEN nullif(person_data->>'deathPlace', '') END,
    published_version
  ) ON CONFLICT (archive_id, person_id) DO UPDATE SET
    name=excluded.name,
    surname_part=excluded.surname_part,
    given_part=excluded.given_part,
    birth_surname=excluded.birth_surname,
    birth_year=excluded.birth_year,
    death_year=excluded.death_year,
    birth_place=excluded.birth_place,
    death_place=excluded.death_place,
    publication_version=excluded.publication_version;
END $$;
