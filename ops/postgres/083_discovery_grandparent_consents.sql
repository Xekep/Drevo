-- One deliberate clue for one published two-edge parent path. The published
-- intermediate card is required: a private or living parent is never exposed
-- through the grandparent relationship.
CREATE TABLE discovery_grandparent_consents (
  archive_id text NOT NULL,
  person_id text NOT NULL,
  first_relation_id text NOT NULL,
  second_relation_id text NOT NULL,
  via_person_id text NOT NULL,
  relative_person_id text NOT NULL,
  relative_name text NOT NULL,
  relative_name_key text GENERATED ALWAYS AS
    (replace(lower(relative_name), 'ё', 'е')) STORED,
  PRIMARY KEY (archive_id, person_id, first_relation_id, second_relation_id),
  CHECK (person_id<>via_person_id AND person_id<>relative_person_id
    AND via_person_id<>relative_person_id),
  FOREIGN KEY (archive_id, person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, via_person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, relative_person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, first_relation_id)
    REFERENCES relations(archive_id, id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, second_relation_id)
    REFERENCES relations(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX discovery_grandparent_consents_lookup
  ON discovery_grandparent_consents(relative_name_key, archive_id, person_id);
CREATE INDEX discovery_grandparent_consents_via
  ON discovery_grandparent_consents(archive_id, via_person_id);
CREATE INDEX discovery_grandparent_consents_relative
  ON discovery_grandparent_consents(archive_id, relative_person_id);
CREATE INDEX discovery_grandparent_consents_second_relation
  ON discovery_grandparent_consents(archive_id, second_relation_id);
ALTER TABLE discovery_grandparent_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_grandparent_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_grandparent_consents_read ON discovery_grandparent_consents
  FOR SELECT USING (true);
CREATE POLICY discovery_grandparent_consents_insert ON discovery_grandparent_consents
  FOR INSERT WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
CREATE POLICY discovery_grandparent_consents_update ON discovery_grandparent_consents
  FOR UPDATE USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
CREATE POLICY discovery_grandparent_consents_delete ON discovery_grandparent_consents
  FOR DELETE USING (archive_id=current_setting('drevo.archive_id', true));

-- Writers of a clue take the same focal publication exclusively. Candidate
-- delivery SHARE-locks it before comparing the selected clues and sending.
CREATE FUNCTION lock_discovery_grandparent_focal() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM discovery_people
    WHERE archive_id=OLD.archive_id AND person_id=OLD.person_id FOR UPDATE;
  IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER lock_discovery_grandparent_focal
  BEFORE UPDATE OR DELETE ON discovery_grandparent_consents
  FOR EACH ROW EXECUTE FUNCTION lock_discovery_grandparent_focal();

-- A name edit changes the disclosure preview, including a newly published
-- spelling of the intermediate parent. It requires a fresh explicit opt-in.
CREATE FUNCTION revoke_renamed_discovery_grandparent_person() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    DELETE FROM discovery_grandparent_consents
      WHERE archive_id=NEW.archive_id AND
        (person_id=NEW.person_id OR via_person_id=NEW.person_id OR
          relative_person_id=NEW.person_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_renamed_discovery_grandparent_person
  AFTER UPDATE OF name ON discovery_people
  FOR EACH ROW EXECUTE FUNCTION revoke_renamed_discovery_grandparent_person();

-- FK cascades cover DELETE; changing either edge must not silently grant a
-- different path with the same relation ID. Republish never restores a row.
CREATE FUNCTION revoke_changed_discovery_grandparent_relation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF (NEW.source,NEW.target,NEW.type) IS DISTINCT FROM
      (OLD.source,OLD.target,OLD.type) THEN
    DELETE FROM discovery_grandparent_consents
      WHERE archive_id=OLD.archive_id AND
        (first_relation_id=OLD.id OR second_relation_id=OLD.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_changed_discovery_grandparent_relation
  AFTER UPDATE OF source,target,type ON relations
  FOR EACH ROW EXECUTE FUNCTION revoke_changed_discovery_grandparent_relation();

-- The candidate algorithm reads only explicitly consented names. Invoker
-- security preserves the underlying RLS checks for every backend process.
CREATE VIEW discovery_candidate_relative_consents WITH (security_invoker=true) AS
  SELECT archive_id,person_id,relation_id AS first_relation_id,
    NULL::text AS second_relation_id,NULL::text AS via_person_id,
    relative_person_id,kind,relative_name,relative_name_key,
    xmin::text AS row_version
    FROM discovery_relative_consents
  UNION ALL
  SELECT archive_id,person_id,first_relation_id,second_relation_id,
    via_person_id,relative_person_id,
    'grandparent'::text AS kind,relative_name,relative_name_key,
    xmin::text AS row_version
    FROM discovery_grandparent_consents;
