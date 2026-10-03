SET LOCAL lock_timeout = '5s';
ALTER TABLE ai_chats ADD COLUMN IF NOT EXISTS stop_token text;
