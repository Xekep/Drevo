-- Only the explicit discovery projection is indexed. A relation enters this
-- auxiliary index only while both endpoints have published projections.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE discovery_people
  ADD COLUMN IF NOT EXISTS given_normalized text GENERATED ALWAYS AS
    (split_part(replace(lower(name), 'ё', 'е'), ' ', 2)) STORED,
  ADD COLUMN IF NOT EXISTS surname_normalized text GENERATED ALWAYS AS
    (split_part(replace(lower(name), 'ё', 'е'), ' ', 1)) STORED,
  ADD COLUMN IF NOT EXISTS birth_surname_normalized text GENERATED ALWAYS AS
    (replace(lower(coalesce(birth_surname, '')), 'ё', 'е')) STORED;
CREATE INDEX IF NOT EXISTS discovery_people_given_trgm
  ON discovery_people USING gin (given_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS discovery_people_surname_trgm
  ON discovery_people USING gin (surname_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS discovery_people_birth_surname_trgm
  ON discovery_people USING gin (birth_surname_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS discovery_people_birth_year ON discovery_people(birth_year);
CREATE INDEX IF NOT EXISTS discovery_people_death_year ON discovery_people(death_year);

CREATE TABLE IF NOT EXISTS discovery_relative_names (
  archive_id text NOT NULL,
  person_id text NOT NULL,
  relative_person_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parent', 'child', 'spouse')),
  relative_name text NOT NULL,
  name_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', replace(lower(relative_name), 'ё', 'е'))) STORED,
  PRIMARY KEY (archive_id, person_id, relative_person_id, kind),
  FOREIGN KEY (archive_id, person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, relative_person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discovery_relative_names_lookup
  ON discovery_relative_names USING gin(name_vector);
CREATE INDEX IF NOT EXISTS discovery_relative_names_person
  ON discovery_relative_names(archive_id, person_id);
CREATE INDEX IF NOT EXISTS discovery_relative_names_relative
  ON discovery_relative_names(archive_id, relative_person_id);

CREATE OR REPLACE FUNCTION refresh_discovery_relatives(target_archive text, target_person text)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM discovery_relative_names
    WHERE archive_id=target_archive AND person_id=target_person;
  INSERT INTO discovery_relative_names
    (archive_id,person_id,relative_person_id,kind,relative_name)
  SELECT target_archive,target_person,other.person_id,
    CASE WHEN r.type='spouse' THEN 'spouse'
      WHEN r.source=target_person THEN 'child' ELSE 'parent' END,
    other.name
  FROM relations r
  JOIN discovery_people focal ON focal.archive_id=r.archive_id
    AND focal.person_id=target_person
  JOIN discovery_people other ON other.archive_id=r.archive_id
    AND other.person_id=CASE WHEN r.source=target_person THEN r.target ELSE r.source END
  WHERE r.archive_id=target_archive AND r.type IN ('parent','spouse')
    AND (r.source=target_person OR r.target=target_person)
  ON CONFLICT (archive_id,person_id,relative_person_id,kind)
    DO UPDATE SET relative_name=excluded.relative_name;
END $$;

CREATE OR REPLACE FUNCTION refresh_discovery_relatives_after_person()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE neighbor record;
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  PERFORM refresh_discovery_relatives(NEW.archive_id,NEW.person_id);
  FOR neighbor IN SELECT DISTINCT CASE WHEN r.source=NEW.person_id
      THEN r.target ELSE r.source END AS id
    FROM relations r WHERE r.archive_id=NEW.archive_id
      AND r.type IN ('parent','spouse')
      AND (r.source=NEW.person_id OR r.target=NEW.person_id)
  LOOP
    PERFORM refresh_discovery_relatives(NEW.archive_id,neighbor.id);
  END LOOP;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='discovery_people'::regclass
        AND tgname='refresh_discovery_relatives_after_person') THEN
    CREATE TRIGGER refresh_discovery_relatives_after_person
      AFTER INSERT OR UPDATE OF name ON discovery_people
      FOR EACH ROW EXECUTE FUNCTION refresh_discovery_relatives_after_person();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION refresh_discovery_relatives_after_relation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('DELETE','UPDATE') AND OLD.type IN ('parent','spouse') THEN
    PERFORM refresh_discovery_relatives(OLD.archive_id,OLD.source);
    PERFORM refresh_discovery_relatives(OLD.archive_id,OLD.target);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.type IN ('parent','spouse') THEN
    PERFORM refresh_discovery_relatives(NEW.archive_id,NEW.source);
    PERFORM refresh_discovery_relatives(NEW.archive_id,NEW.target);
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='relations'::regclass
        AND tgname='refresh_discovery_relatives_after_relation') THEN
    CREATE TRIGGER refresh_discovery_relatives_after_relation
      AFTER INSERT OR UPDATE OR DELETE ON relations
      FOR EACH ROW EXECUTE FUNCTION refresh_discovery_relatives_after_relation();
  END IF;
END $$;

-- Existing archives are backfilled once; subsequent edits touch only their
-- affected person and immediate neighbours.
INSERT INTO discovery_relative_names
  (archive_id,person_id,relative_person_id,kind,relative_name)
SELECT r.archive_id,focal.person_id,other.person_id,
  CASE WHEN r.type='spouse' THEN 'spouse'
    WHEN r.source=focal.person_id THEN 'child' ELSE 'parent' END,other.name
FROM relations r
JOIN discovery_people focal ON focal.archive_id=r.archive_id
  AND focal.person_id IN (r.source,r.target)
JOIN discovery_people other ON other.archive_id=r.archive_id
  AND other.person_id=CASE WHEN r.source=focal.person_id THEN r.target ELSE r.source END
WHERE r.type IN ('parent','spouse')
ON CONFLICT DO NOTHING;
