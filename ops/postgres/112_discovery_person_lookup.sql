-- Canonical UUID routes for legacy archives resolve only the published
-- projection. The person lookup must not scan the global directory.
-- Lowercase UUID keys already use the (archive_id,person_id) primary key.
-- Restrict this index to aliases, including uppercase legacy UUID keys. A
-- general person_id index changes the keyset name-backfill join plan.
CREATE INDEX IF NOT EXISTS discovery_people_person_lookup ON discovery_people(person_id)
  WHERE archive_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$';
