ALTER TABLE workflow_stages DROP CONSTRAINT IF EXISTS workflow_stages_kind_check;
ALTER TABLE workflow_stages ADD CONSTRAINT workflow_stages_kind_check
  CHECK (kind IN ('gedcom','restore','drevo'));
