-- Publishing two people does not publish the relationship between them.
-- Remove the candidate-only relationship projection and its refresh hooks.
DROP TRIGGER IF EXISTS refresh_discovery_relatives_after_relation ON relations;
DROP TRIGGER IF EXISTS refresh_discovery_relatives_after_person ON discovery_people;
DROP FUNCTION IF EXISTS refresh_discovery_relatives_after_relation();
DROP FUNCTION IF EXISTS refresh_discovery_relatives_after_person();
DROP FUNCTION IF EXISTS refresh_discovery_relatives(text,text);
DROP TABLE IF EXISTS discovery_relative_names;
