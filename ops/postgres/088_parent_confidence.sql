SET LOCAL lock_timeout = '5s';
DO $$
DECLARE old_names text[];
BEGIN
  SELECT array_agg(conname) INTO old_names FROM pg_constraint
    WHERE conrelid = to_regclass('relations') AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%type <> ALL (ARRAY[''parent''::text, ''spouse''::text])%'
      AND pg_get_constraintdef(oid) LIKE '%confidence = ANY%';
  IF coalesce(array_length(old_names, 1), 0) <> 1 THEN
    RAISE EXCEPTION 'Unexpected parent confidence constraint';
  END IF;
  EXECUTE format('ALTER TABLE relations DROP CONSTRAINT %I', old_names[1]);
END $$;
ALTER TABLE relations ADD CONSTRAINT relations_parent_confidence_check
  CHECK (confidence IS NULL OR (type <> 'spouse' AND confidence IN
    ('confirmed','probable','tentative','conflicting','unknown')));

CREATE FUNCTION protect_parent_evidence_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type = 'parent' AND
    (OLD.sources <> '[]'::jsonb OR OLD.confidence IS NOT NULL) AND
    (TG_OP = 'DELETE' OR NEW.archive_id IS DISTINCT FROM OLD.archive_id OR
      NEW.source IS DISTINCT FROM OLD.source OR
      NEW.target IS DISTINCT FROM OLD.target OR NEW.type IS DISTINCT FROM OLD.type OR
      NEW.sources IS DISTINCT FROM OLD.sources OR
      NEW.confidence IS DISTINCT FROM OLD.confidence) AND
    current_setting('drevo.parent_evidence_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Unsupported writer for parent evidence';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_parent_evidence_before_write
BEFORE UPDATE OR DELETE ON relations
FOR EACH ROW EXECUTE FUNCTION protect_parent_evidence_write();
