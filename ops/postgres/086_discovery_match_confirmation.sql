-- A confirmation captures only the fields selected for publication at the
-- instant the responding owner accepts. Old links are deliberately not
-- backfilled: their historical facts cannot be reconstructed reliably.
CREATE TABLE discovery_match_confirmations (
  match_id text PRIMARY KEY REFERENCES discovery_match_requests(id) ON DELETE CASCADE,
  review_token text NOT NULL CHECK (review_token ~ '^[0-9a-f]{64}$'),
  left_publication_version text NOT NULL,
  right_publication_version text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  created_txid bigint NOT NULL DEFAULT txid_current()
);
ALTER TABLE discovery_match_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_match_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_match_confirmations_read ON discovery_match_confirmations
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM discovery_match_requests m
    JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
    JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
    WHERE m.id=match_id AND m.status='linked'
      AND (m.left_archive_id=current_setting('drevo.archive_id',true)
      OR m.right_archive_id=current_setting('drevo.archive_id',true))
  ));
CREATE POLICY discovery_match_confirmations_insert ON discovery_match_confirmations
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM discovery_match_requests m
    JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
    JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
    WHERE m.id=match_id AND m.status='linked'
      AND (m.left_archive_id=current_setting('drevo.archive_id',true)
        OR m.right_archive_id=current_setting('drevo.archive_id',true))
  ));

-- One row per visible field lets RLS revoke a formerly published field without
-- revealing its old value through direct SQL. No UPDATE/DELETE policy exists;
-- rows survive ordinary card edits and disappear with the match/archive.
CREATE TABLE discovery_match_confirmation_fields (
  match_id text NOT NULL REFERENCES discovery_match_confirmations(match_id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('left','right')),
  field_name text NOT NULL CHECK (field_name IN
    ('name','birthSurname','birthYear','deathYear','birthPlace','deathPlace')),
  field_value text NOT NULL,
  PRIMARY KEY (match_id,side,field_name)
);
ALTER TABLE discovery_match_confirmation_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_match_confirmation_fields FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_match_confirmation_fields_read ON discovery_match_confirmation_fields
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM discovery_match_requests m
    JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
    JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
    WHERE m.id=match_id AND m.status='linked'
      AND (m.left_archive_id=current_setting('drevo.archive_id',true)
      OR m.right_archive_id=current_setting('drevo.archive_id',true))
      AND NULLIF(CASE side
        WHEN 'left' THEN CASE field_name
          WHEN 'name' THEN l.name WHEN 'birthSurname' THEN l.birth_surname
          WHEN 'birthYear' THEN l.birth_year WHEN 'deathYear' THEN l.death_year
          WHEN 'birthPlace' THEN l.birth_place WHEN 'deathPlace' THEN l.death_place END
        ELSE CASE field_name
          WHEN 'name' THEN r.name WHEN 'birthSurname' THEN r.birth_surname
          WHEN 'birthYear' THEN r.birth_year WHEN 'deathYear' THEN r.death_year
          WHEN 'birthPlace' THEN r.birth_place WHEN 'deathPlace' THEN r.death_place END
      END, '') IS NOT NULL
  ));
CREATE POLICY discovery_match_confirmation_fields_insert ON discovery_match_confirmation_fields
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM discovery_match_confirmations c
      WHERE c.match_id=discovery_match_confirmation_fields.match_id
        AND c.created_txid=txid_current()
  ));
