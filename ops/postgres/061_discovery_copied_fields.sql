-- Transfer provenance is not a documentary citation. It belongs only to the
-- receiving archive and survives revocation or deletion of the source grant.
CREATE TABLE IF NOT EXISTS discovery_copied_fields (
  archive_id text NOT NULL,
  person_id text NOT NULL,
  field text NOT NULL CHECK (field IN ('birth','death','birthPlace','deathPlace')),
  value text NOT NULL CHECK (value <> '' AND length(value) <= 300),
  source_archive_id text NOT NULL,
  source_person_id text NOT NULL,
  copied_revision bigint NOT NULL CHECK (copied_revision > 0),
  copied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archive_id,person_id,field),
  FOREIGN KEY (archive_id,person_id) REFERENCES people(archive_id,id) ON DELETE CASCADE
);
ALTER TABLE discovery_copied_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_copied_fields FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY discovery_copied_fields_archive ON discovery_copied_fields
    USING (archive_id=current_setting('drevo.archive_id',true))
    WITH CHECK (archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A later local edit of the copied value must not keep attributing the new
-- value to the other archive. Unrelated edits leave provenance untouched.
CREATE OR REPLACE FUNCTION clear_changed_discovery_copy_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Account maintenance may change search_path; runtime tables live in public.
  DELETE FROM public.discovery_copied_fields c
    WHERE c.archive_id=NEW.archive_id AND c.person_id=NEW.id
      AND NEW.data->>c.field IS DISTINCT FROM c.value;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS clear_changed_discovery_copy_provenance ON people;
CREATE TRIGGER clear_changed_discovery_copy_provenance
  AFTER UPDATE OF data ON people FOR EACH ROW
  EXECUTE FUNCTION clear_changed_discovery_copy_provenance();
