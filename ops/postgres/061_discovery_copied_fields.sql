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

-- A confirmed public link can survive ownership transfer, but a successor
-- must never inherit either side's private scalar snapshot. RLS permits only
-- the grantor to DELETE a grant; visit the two exact grantor scopes in turn.
CREATE OR REPLACE FUNCTION revoke_discovery_card_grants_after_owner_transfer()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE original_archive text := current_setting('drevo.archive_id',true);
DECLARE grantors text[];
DECLARE grantor text;
BEGIN
  IF NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN RETURN NEW; END IF;
  IF original_archive IS DISTINCT FROM NEW.archive_id THEN
    RAISE EXCEPTION 'Scalar grant transfer revoke requires the archive context';
  END IF;
  SELECT array_agg(DISTINCT g.grantor_archive_id) INTO grantors
    FROM discovery_linked_card_grants g
   WHERE g.left_archive_id=NEW.archive_id OR g.right_archive_id=NEW.archive_id;
  FOREACH grantor IN ARRAY coalesce(grantors,ARRAY[]::text[]) LOOP
    PERFORM set_config('drevo.archive_id',grantor,true);
    DELETE FROM discovery_linked_card_grants g
     WHERE g.grantor_archive_id=grantor
       AND (g.left_archive_id=NEW.archive_id OR g.right_archive_id=NEW.archive_id);
  END LOOP;
  PERFORM set_config('drevo.archive_id',original_archive,true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF original_archive IS NOT NULL THEN
    PERFORM set_config('drevo.archive_id',original_archive,true);
  END IF;
  RAISE;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='archive_owners'::regclass
        AND tgname='revoke_discovery_card_grants_after_owner_transfer'
        AND NOT tgisinternal) THEN
    -- 054 did not record both owners at grant time. Existing grants cannot be
    -- proven to have their current owners' consent, so clear them once on
    -- installation. The trigger marker prevents a retry from erasing grants
    -- issued after 061 is installed. TRUNCATE is atomic with this migration.
    TRUNCATE public.discovery_linked_card_grants;
    CREATE TRIGGER revoke_discovery_card_grants_after_owner_transfer
      AFTER UPDATE OF user_id ON archive_owners FOR EACH ROW
      EXECUTE FUNCTION revoke_discovery_card_grants_after_owner_transfer();
  END IF;
END $$;
