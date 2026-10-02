-- A second-generation member is visible only through a selected, published
-- first-generation member of the same explicit bilateral branch grant.
ALTER TABLE discovery_branch_members
  ADD COLUMN IF NOT EXISTS via_person_id text;

ALTER TABLE discovery_branch_members
  DROP CONSTRAINT IF EXISTS discovery_branch_members_relation_check;
ALTER TABLE discovery_branch_members
  ADD CONSTRAINT discovery_branch_members_relation_check CHECK (
    (relation IN ('parent','child','spouse') AND via_person_id IS NULL)
    OR (relation IN ('grandparent','grandchild','sibling')
      AND via_person_id IS NOT NULL AND via_person_id<>person_id)
  );

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='discovery_branch_members'::regclass
      AND conname='discovery_branch_members_via_fkey') THEN
    ALTER TABLE discovery_branch_members
      ADD CONSTRAINT discovery_branch_members_via_fkey
      FOREIGN KEY (left_archive_id,left_person_id,right_archive_id,right_person_id,
        grantor_archive_id,via_person_id)
      REFERENCES discovery_branch_members(left_archive_id,left_person_id,
        right_archive_id,right_person_id,grantor_archive_id,person_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS discovery_branch_members_via
  ON discovery_branch_members(left_archive_id,left_person_id,right_archive_id,
    right_person_id,grantor_archive_id,via_person_id)
  WHERE via_person_id IS NOT NULL;
