-- A deleted chat queues its registered provider conversation in the same
-- transaction, including membership/account deletes and archive FK cascades.
-- The platform ledger intentionally has no cascading archive/account FK.
CREATE OR REPLACE FUNCTION public.queue_deleted_ai_chat_conversation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  queued_at bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF OLD.provider_cleanup_ref IS NOT NULL THEN
    UPDATE public.platform_ai_conversations
       SET state='pending', available_at=queued_at, updated_at=queued_at
     WHERE id=OLD.provider_cleanup_ref AND state IN ('binding','active');
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS queue_deleted_ai_chat_conversation ON public.ai_chats;
CREATE TRIGGER queue_deleted_ai_chat_conversation
AFTER DELETE ON public.ai_chats FOR EACH ROW
EXECUTE FUNCTION public.queue_deleted_ai_chat_conversation();
