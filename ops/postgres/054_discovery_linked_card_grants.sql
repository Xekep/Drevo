-- A grant is a snapshot of explicitly selected scalar fields for one linked
-- published pair. Revoking the link or either publication deletes it at once.
CREATE TABLE IF NOT EXISTS discovery_linked_card_grants (
  left_archive_id text NOT NULL,
  left_person_id text NOT NULL,
  right_archive_id text NOT NULL,
  right_person_id text NOT NULL,
  grantor_archive_id text NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object'
    AND fields <> '{}'::jsonb
    AND fields - 'birth' - 'death' - 'birthPlace' - 'deathPlace' - 'occupation' = '{}'::jsonb
    AND fields::text !~ '[<>]'
    AND (fields->'birth' IS NULL OR
      (jsonb_typeof(fields->'birth')='string' AND length(fields->>'birth')<=100))
    AND (fields->'death' IS NULL OR
      (jsonb_typeof(fields->'death')='string' AND length(fields->>'death')<=100))
    AND (fields->'birthPlace' IS NULL OR
      (jsonb_typeof(fields->'birthPlace')='string' AND length(fields->>'birthPlace')<=300))
    AND (fields->'deathPlace' IS NULL OR
      (jsonb_typeof(fields->'deathPlace')='string' AND length(fields->>'deathPlace')<=300))
    AND (fields->'occupation' IS NULL OR
      (jsonb_typeof(fields->'occupation')='string' AND length(fields->>'occupation')<=200))),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (left_archive_id,left_person_id,right_archive_id,right_person_id,grantor_archive_id),
  CHECK (grantor_archive_id IN (left_archive_id,right_archive_id)),
  FOREIGN KEY (left_archive_id,left_person_id,right_archive_id,right_person_id)
    REFERENCES discovery_linked_pairs(
      left_archive_id,left_person_id,right_archive_id,right_person_id) ON DELETE CASCADE
);
ALTER TABLE discovery_linked_card_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_linked_card_grants FORCE ROW LEVEL SECURITY;
-- Multiple backend processes can enter the runtime migration concurrently.
-- CREATE TABLE is idempotent; each policy must tolerate the same race.
DO $$ BEGIN
  CREATE POLICY discovery_linked_card_read ON discovery_linked_card_grants
    FOR SELECT USING (left_archive_id=current_setting('drevo.archive_id',true)
      OR right_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY discovery_linked_card_insert ON discovery_linked_card_grants
    FOR INSERT WITH CHECK (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY discovery_linked_card_update ON discovery_linked_card_grants
    FOR UPDATE USING (grantor_archive_id=current_setting('drevo.archive_id',true))
    WITH CHECK (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY discovery_linked_card_delete ON discovery_linked_card_grants
    FOR DELETE USING (grantor_archive_id=current_setting('drevo.archive_id',true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
