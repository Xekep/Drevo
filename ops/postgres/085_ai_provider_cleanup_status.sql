-- Completed/active conversations do not enter the operational queue listing.
CREATE INDEX IF NOT EXISTS platform_ai_conversations_status
ON public.platform_ai_conversations(updated_at DESC,id DESC)
WHERE state IN ('binding','pending','leased','blocked');

CREATE INDEX IF NOT EXISTS platform_ai_conversations_blocked_status
ON public.platform_ai_conversations(updated_at DESC,id DESC)
WHERE state='blocked';
