-- Canonical UUID routes for legacy archives resolve only the published
-- projection. The person lookup must not scan the global directory.
CREATE INDEX IF NOT EXISTS discovery_people_person_lookup ON discovery_people(person_id);
