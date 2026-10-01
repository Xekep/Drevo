-- A branch is an explicit, bounded set of published direct relatives for one
-- confirmed pair. Both archives must opt in before either can view the other.
CREATE TABLE IF NOT EXISTS discovery_branch_grants (
  left_archive_id text NOT NULL,
  left_person_id text NOT NULL,
  right_archive_id text NOT NULL,
  right_person_id text NOT NULL,
  grantor_archive_id text NOT NULL,
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id),
  CHECK (grantor_archive_id IN (left_archive_id,right_archive_id)),
  FOREIGN KEY (left_archive_id,left_person_id,right_archive_id,right_person_id)
    REFERENCES discovery_linked_pairs(
      left_archive_id,left_person_id,right_archive_id,right_person_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discovery_branch_grants_grantor
  ON discovery_branch_grants(grantor_archive_id);
ALTER TABLE discovery_branch_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_branch_grants FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY discovery_branch_grants_read ON discovery_branch_grants FOR SELECT
    USING (left_archive_id=current_setting('drevo.archive_id',true)
      OR right_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY discovery_branch_grants_insert ON discovery_branch_grants FOR INSERT
    WITH CHECK (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY discovery_branch_grants_update ON discovery_branch_grants FOR UPDATE
    USING (grantor_archive_id=current_setting('drevo.archive_id',true))
    WITH CHECK (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY discovery_branch_grants_delete ON discovery_branch_grants FOR DELETE
    USING (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS discovery_branch_members (
  left_archive_id text NOT NULL,
  left_person_id text NOT NULL,
  right_archive_id text NOT NULL,
  right_person_id text NOT NULL,
  grantor_archive_id text NOT NULL,
  person_id text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('parent','child','spouse')),
  PRIMARY KEY (left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id,person_id),
  FOREIGN KEY (left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id)
    REFERENCES discovery_branch_grants(
      left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id) ON DELETE CASCADE,
  FOREIGN KEY (grantor_archive_id,person_id)
    REFERENCES discovery_people(archive_id,person_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discovery_branch_members_person
  ON discovery_branch_members(grantor_archive_id,person_id);
ALTER TABLE discovery_branch_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_branch_members FORCE ROW LEVEL SECURITY;
-- The member FK proves the source grant exists; an opposite archive can read
-- that row only after it has also granted this exact pair.
DO $$ BEGIN
  CREATE POLICY discovery_branch_members_read ON discovery_branch_members FOR SELECT
    USING (grantor_archive_id=current_setting('drevo.archive_id',true)
      OR ((left_archive_id=current_setting('drevo.archive_id',true)
        OR right_archive_id=current_setting('drevo.archive_id',true))
        AND EXISTS (SELECT 1 FROM discovery_branch_grants own_grant
          WHERE own_grant.left_archive_id=discovery_branch_members.left_archive_id
            AND own_grant.left_person_id=discovery_branch_members.left_person_id
            AND own_grant.right_archive_id=discovery_branch_members.right_archive_id
            AND own_grant.right_person_id=discovery_branch_members.right_person_id
            AND own_grant.grantor_archive_id=current_setting('drevo.archive_id',true))));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY discovery_branch_members_insert ON discovery_branch_members FOR INSERT
    WITH CHECK (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY discovery_branch_members_delete ON discovery_branch_members FOR DELETE
    USING (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A changed family graph invalidates the saved relation choices. Publication
-- revocation separately cascades through discovery_people immediately.
CREATE OR REPLACE FUNCTION revoke_discovery_branches_after_edit()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    DELETE FROM discovery_branch_grants WHERE grantor_archive_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

-- Ownership transfer does not change archives.revision. A successor must
-- grant branch access personally rather than inherit the former owner's opt-in.
CREATE OR REPLACE FUNCTION revoke_discovery_branches_after_owner_transfer()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    DELETE FROM discovery_branch_grants WHERE grantor_archive_id=NEW.archive_id;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='archive_owners'::regclass
        AND tgname='revoke_discovery_branches_after_owner_transfer') THEN
    CREATE TRIGGER revoke_discovery_branches_after_owner_transfer
      AFTER UPDATE OF user_id ON archive_owners FOR EACH ROW
      EXECUTE FUNCTION revoke_discovery_branches_after_owner_transfer();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='archives'::regclass AND tgname='revoke_discovery_branches_after_edit') THEN
    CREATE TRIGGER revoke_discovery_branches_after_edit
      AFTER UPDATE OF revision ON archives FOR EACH ROW
      EXECUTE FUNCTION revoke_discovery_branches_after_edit();
  END IF;
END $$;
