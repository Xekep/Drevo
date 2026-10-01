-- Existing installations need the new additional relationship types and
-- a dedicated field for the stated type of twins. Existing rows are kept.
ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_type_check;
ALTER TABLE relations ADD CONSTRAINT relations_type_check
  CHECK (type IN ('parent','spouse','adoptive_parent','foster_parent','presumed_parent','step_parent','godparent','nurse','sworn_sibling','guardian','twin'));
ALTER TABLE relations ADD COLUMN IF NOT EXISTS twin_kind text;
ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_twin_kind_check;
ALTER TABLE relations ADD CONSTRAINT relations_twin_kind_check
  CHECK (twin_kind IS NULL OR (type='twin' AND twin_kind IN ('identical','fraternal','unknown')));
