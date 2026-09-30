-- Candidate lookup uses only explicitly published names. Keep its index separate
-- from the general search vector, which also contains years and places.
ALTER TABLE discovery_people ADD COLUMN name_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', replace(lower(coalesce(name, '') || ' ' ||
    coalesce(birth_surname, '')), 'ё', 'е'))
) STORED;
CREATE INDEX discovery_people_names ON discovery_people USING gin(name_vector);
