ALTER TABLE discovery_match_requests ADD COLUMN reason text;
ALTER TABLE discovery_match_requests ADD CONSTRAINT discovery_match_reason_length
  CHECK (reason IS NULL OR char_length(reason) <= 500);
