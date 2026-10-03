SET LOCAL lock_timeout = '5s';
ALTER TABLE relations ADD COLUMN IF NOT EXISTS confidence text
  CHECK (confidence IS NULL OR (type NOT IN ('parent','spouse') AND confidence IN
    ('confirmed','probable','tentative','conflicting','unknown')));
