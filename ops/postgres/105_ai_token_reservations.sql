ALTER TABLE platform_ai_usage ADD COLUMN IF NOT EXISTS reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0);
ALTER TABLE platform_ai_usage ADD COLUMN IF NOT EXISTS uncertain_tokens bigint NOT NULL DEFAULT 0 CHECK (uncertain_tokens >= 0);
-- The portable SQLite projection uses the retained archive-local usage schema.
-- Its columns must match SQLite even though live quotas use platform_ai_usage.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0);
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS uncertain_tokens bigint NOT NULL DEFAULT 0 CHECK (uncertain_tokens >= 0);
