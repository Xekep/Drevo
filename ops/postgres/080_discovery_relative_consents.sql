-- A person's publication does not publish the relationship. Each row is a
-- separate, revocable owner opt-in for one focal person and one close relation.
-- It contains only names already in discovery_people, never private graph data.
CREATE TABLE discovery_relative_consents (
  archive_id text NOT NULL,
  person_id text NOT NULL,
  relation_id text NOT NULL,
  relative_person_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parent', 'child', 'spouse')),
  relative_name text NOT NULL,
  relative_name_key text GENERATED ALWAYS AS
    (replace(lower(relative_name), 'ё', 'е')) STORED,
  PRIMARY KEY (archive_id, person_id, relation_id),
  FOREIGN KEY (archive_id, person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, relative_person_id)
    REFERENCES discovery_people(archive_id, person_id) ON DELETE CASCADE,
  FOREIGN KEY (archive_id, relation_id)
    REFERENCES relations(archive_id, id) ON DELETE CASCADE
);
CREATE INDEX discovery_relative_consents_relative
  ON discovery_relative_consents(archive_id, relative_person_id);
CREATE INDEX discovery_relative_consents_relation
  ON discovery_relative_consents(archive_id, relation_id);
CREATE INDEX discovery_relative_consents_lookup
  ON discovery_relative_consents(kind, relative_name_key, archive_id, person_id);
ALTER TABLE discovery_relative_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_relative_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_relative_consents_read ON discovery_relative_consents
  FOR SELECT USING (true);
CREATE POLICY discovery_relative_consents_insert ON discovery_relative_consents
  FOR INSERT WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
CREATE POLICY discovery_relative_consents_update ON discovery_relative_consents
  FOR UPDATE USING (archive_id=current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id', true));
CREATE POLICY discovery_relative_consents_delete ON discovery_relative_consents
  FOR DELETE USING (archive_id=current_setting('drevo.archive_id', true));

-- Readers may lock the globally readable published focal card. Writers of an
-- opt-in row take the same card exclusively before changing the clue. This
-- avoids granting cross-archive UPDATE RLS merely to make FOR SHARE work.
CREATE FUNCTION lock_discovery_relative_focal() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  PERFORM 1 FROM discovery_people
    WHERE archive_id=OLD.archive_id AND person_id=OLD.person_id FOR UPDATE;
  IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER lock_discovery_relative_focal
  BEFORE UPDATE OR DELETE ON discovery_relative_consents
  FOR EACH ROW EXECUTE FUNCTION lock_discovery_relative_focal();

CREATE FUNCTION sync_discovery_relative_name() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE discovery_relative_consents SET relative_name=NEW.name
      WHERE archive_id=NEW.archive_id AND relative_person_id=NEW.person_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_discovery_relative_name AFTER UPDATE OF name ON discovery_people
  FOR EACH ROW EXECUTE FUNCTION sync_discovery_relative_name();

CREATE FUNCTION revoke_changed_discovery_relation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF (NEW.source,NEW.target,NEW.type) IS DISTINCT FROM
      (OLD.source,OLD.target,OLD.type) THEN
    DELETE FROM discovery_relative_consents
      WHERE archive_id=OLD.archive_id AND relation_id=OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_changed_discovery_relation
  AFTER UPDATE OF source,target,type ON relations
  FOR EACH ROW EXECUTE FUNCTION revoke_changed_discovery_relation();
