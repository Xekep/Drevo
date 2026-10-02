-- A change to living/unknown status withdraws the owner's old opt-in. A stale
-- opt-in created while the person was ineligible must not become active later.
CREATE OR REPLACE FUNCTION revoke_ineligible_discovery_publication()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT (
    coalesce(OLD.data->>'deceased' = 'true', false) OR
    nullif(OLD.data->>'death', '') IS NOT NULL
  ) OR NOT (
    coalesce(NEW.data->>'deceased' = 'true', false) OR
    nullif(NEW.data->>'death', '') IS NOT NULL
  ) THEN
    DELETE FROM published_people
     WHERE archive_id=NEW.archive_id AND person_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS discovery_revoke_ineligible_publication ON people;
CREATE TRIGGER discovery_revoke_ineligible_publication
  AFTER UPDATE OF data ON people
  FOR EACH ROW WHEN (OLD.data IS DISTINCT FROM NEW.data)
  EXECUTE FUNCTION revoke_ineligible_discovery_publication();

-- The trigger is global, but existing opt-ins must be reconciled once per
-- archive as its runtime opens under that archive's RLS scope.
CREATE TABLE IF NOT EXISTS discovery_publication_reconciled_archives (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  reconciled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE discovery_publication_reconciled_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_publication_reconciled_archives FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON discovery_publication_reconciled_archives;
CREATE POLICY archive_scope ON discovery_publication_reconciled_archives
  USING (archive_id = current_setting('drevo.archive_id', true))
  WITH CHECK (archive_id = current_setting('drevo.archive_id', true));

DELETE FROM published_people published
 USING people p
 WHERE p.archive_id=published.archive_id AND p.id=published.person_id
   AND NOT (
     coalesce(p.data->>'deceased' = 'true', false) OR
     nullif(p.data->>'death', '') IS NOT NULL
   );
INSERT INTO discovery_publication_reconciled_archives(archive_id)
  VALUES(current_setting('drevo.archive_id', true)) ON CONFLICT DO NOTHING;
