ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS code_interpreter_enabled bigint
  NOT NULL DEFAULT 0 CHECK (code_interpreter_enabled IN (0,1));
