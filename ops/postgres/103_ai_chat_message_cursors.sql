-- A per-chat committed change cursor covers edits to old messages as well as
-- appended messages. Allocating it under the chat row lock preserves commit order.
SELECT pg_advisory_xact_lock(186743294);
ALTER TABLE ai_chats ADD COLUMN IF NOT EXISTS messages_version bigint NOT NULL DEFAULT 0;
ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS change_version bigint NOT NULL DEFAULT 0;
UPDATE ai_chat_messages SET change_version=id WHERE change_version=0;
UPDATE ai_chats c SET messages_version=GREATEST(c.messages_version,
  COALESCE((SELECT max(m.change_version) FROM ai_chat_messages m WHERE m.archive_id=c.archive_id AND m.chat_id=c.id),0));
CREATE INDEX IF NOT EXISTS ai_chat_messages_change_cursor ON ai_chat_messages(archive_id,chat_id,change_version,id);
CREATE OR REPLACE FUNCTION drevo_ai_message_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_chats SET messages_version=messages_version+1,
    updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE archive_id=NEW.archive_id AND id=NEW.chat_id
    RETURNING messages_version INTO NEW.change_version;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_chat_messages_change_cursor ON ai_chat_messages;
CREATE TRIGGER ai_chat_messages_change_cursor BEFORE INSERT OR UPDATE OF content,data,role
  ON ai_chat_messages FOR EACH ROW EXECUTE FUNCTION drevo_ai_message_cursor();
CREATE OR REPLACE FUNCTION drevo_ai_proposal_status_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE ai_chat_messages SET data=jsonb_set(data,'{suggestionStatuses}',
      COALESCE(data->'suggestionStatuses','{}'::jsonb)||jsonb_build_object(NEW.id,NEW.status))
    WHERE archive_id=NEW.archive_id AND COALESCE(data->'suggestionIds','[]'::jsonb) ? NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_proposal_status_cursor ON research_suggestions;
CREATE TRIGGER ai_proposal_status_cursor AFTER UPDATE OF status ON research_suggestions
  FOR EACH ROW EXECUTE FUNCTION drevo_ai_proposal_status_cursor();
