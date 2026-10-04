-- A selected, published branch member can explicitly lead to another selected
-- member. The existing self-FK makes publication withdrawal cascade through
-- the whole chosen path; no general family graph is made public.
ALTER TABLE discovery_branch_members
  DROP CONSTRAINT discovery_branch_members_relation_check,
  ADD CONSTRAINT discovery_branch_members_relation_check CHECK (
    (relation IN ('parent','child','spouse') AND via_person_id IS NULL)
    OR (relation IN ('grandparent','grandchild','sibling','relative')
      AND via_person_id IS NOT NULL AND via_person_id<>person_id)
  ) NOT VALID;
