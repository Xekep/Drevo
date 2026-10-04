-- Only explicitly published name components enter these indexes.  The
-- existing generated surname_normalized uses the first word of the full name,
-- so it cannot serve exact lookup for a published multiword surname.
CREATE INDEX discovery_people_tier_current
  ON discovery_people (
    (replace(lower(coalesce(nullif(given_part,''),split_part(name,' ',2))), 'ё', 'е')),
    (replace(lower(coalesce(nullif(surname_part,''),split_part(name,' ',1))), 'ё', 'е')),
    (coalesce(birth_year,'9999')), name COLLATE "C", archive_id COLLATE "C", person_id COLLATE "C"
  );
CREATE INDEX discovery_people_tier_birth_surname
  ON discovery_people (
    (replace(lower(coalesce(nullif(given_part,''),split_part(name,' ',2))), 'ё', 'е')),
    birth_surname_normalized,
    (coalesce(birth_year,'9999')), name COLLATE "C", archive_id COLLATE "C", person_id COLLATE "C"
  );
