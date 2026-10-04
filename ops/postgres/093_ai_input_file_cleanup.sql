-- Input Files can outlive a chat, archive, or account. Keep their deletion
-- obligation in the platform schema without a cascading family reference.
CREATE TABLE IF NOT EXISTS public.platform_ai_input_files (
  id uuid PRIMARY KEY,
  key_version integer NOT NULL REFERENCES public.platform_ai_cleanup_keys(version),
  encrypted_snapshot text,
  state text NOT NULL CHECK (state IN ('binding','pending','leased','blocked','done')),
  available_at bigint NOT NULL,
  lease_token uuid,
  lease_until bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (state='done' OR encrypted_snapshot IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_ai_input_files_due
  ON public.platform_ai_input_files(state,available_at,id)
  WHERE state IN ('binding','pending','leased');
CREATE INDEX IF NOT EXISTS platform_ai_input_files_status
  ON public.platform_ai_input_files(updated_at DESC,id DESC)
  WHERE state IN ('binding','pending','leased','blocked');
CREATE INDEX IF NOT EXISTS platform_ai_input_files_blocked_status
  ON public.platform_ai_input_files(updated_at DESC,id DESC)
  WHERE state='blocked';
