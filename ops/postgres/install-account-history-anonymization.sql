-- Run as a PostgreSQL administrator (SUPERUSER or BYPASSRLS) after schema 052.
-- The app role keeps FORCE RLS and receives EXECUTE only on the checked entry
-- point. Re-running this script safely cleans remaining old tombstones.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Account history installation requires BYPASSRLS';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_redact_account_attribution(value jsonb, account_id text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(key,
      CASE WHEN (key='createdBy'
        OR (key IN ('before','after') AND value->>'field'='Владелец'))
        AND item=to_jsonb(account_id)
        THEN to_jsonb('deleted-account'::text)
        ELSE public.runtime_redact_account_attribution(item,account_id) END), '{}'::jsonb)
      INTO result FROM jsonb_each(value) AS fields(key,item);
    RETURN result;
  ELSIF jsonb_typeof(value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(public.runtime_redact_account_attribution(item,account_id) ORDER BY ordinal), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS fields(item,ordinal);
    RETURN result;
  END IF;
  RETURN value;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_anonymize_account_history_rows(account_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE revocation_time text := to_char(clock_timestamp() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF account_id IS NULL OR account_id='' OR NOT EXISTS (
    SELECT 1 FROM public.deleted_account_tombstones WHERE id=account_id
  ) THEN
    RAISE EXCEPTION 'No deletion tombstone for account';
  END IF;

  UPDATE public.archive_audit_entries SET actor_id='deleted-account',actor_name='Удалённый участник'
    WHERE actor_id=account_id;
  UPDATE public.archive_audit_entries SET entity_id='deleted-account',label='Удалённый участник'
    WHERE entity='user' AND entity_id=account_id;
  UPDATE public.archive_audit_entries
    SET details=public.runtime_redact_account_attribution(details,account_id)
    WHERE action='Передано владение деревом' AND (
      jsonb_path_exists(details,'$.**.before ? (@ == $account)',jsonb_build_object('account',account_id))
      OR jsonb_path_exists(details,'$.**.after ? (@ == $account)',jsonb_build_object('account',account_id))
    );
  UPDATE public.person_comments SET author_id='deleted-account',author_name='Удалённый участник'
    WHERE author_id=account_id;
  UPDATE public.person_removals SET actor_id='deleted-account' WHERE actor_id=account_id;
  UPDATE public.research_suggestions SET
    created_by=CASE WHEN created_by=account_id THEN 'deleted-account' ELSE created_by END,
    reviewed_by=CASE WHEN reviewed_by=account_id THEN 'deleted-account' ELSE reviewed_by END
    WHERE created_by=account_id OR reviewed_by=account_id;
  UPDATE public.ai_usage SET user_id='deleted-account' WHERE user_id=account_id;
  UPDATE public.share_links SET revoked_at=COALESCE(revoked_at,revocation_time),
    created_by='deleted-account',created_name='Удалённый участник'
    WHERE created_by=account_id;
  UPDATE public.mcp_tokens SET revoked_at=COALESCE(revoked_at,revocation_time),
    created_by='deleted-account' WHERE created_by=account_id;
  UPDATE public.mcp_tokens SET revoked_at=COALESCE(revoked_at,revocation_time)
    WHERE bound_user_id=account_id AND revoked_at IS NULL;
  UPDATE public.face_descriptors SET created_by=NULL WHERE created_by=account_id;
  UPDATE public.relations SET created_by=NULL WHERE created_by=account_id;
  UPDATE public.documents SET uploaded_by='deleted-account' WHERE uploaded_by=account_id;
  UPDATE public.discovery_match_requests SET
    requested_by=CASE WHEN requested_by=account_id THEN 'deleted-account' ELSE requested_by END,
    responded_by=CASE WHEN responded_by=account_id THEN 'deleted-account' ELSE responded_by END,
    revoked_by=CASE WHEN revoked_by=account_id THEN 'deleted-account' ELSE revoked_by END
    WHERE requested_by=account_id OR responded_by=account_id OR revoked_by=account_id;

  UPDATE public.people SET data=jsonb_set(data,'{createdBy}',to_jsonb('deleted-account'::text))
    WHERE data->>'createdBy'=account_id;
  UPDATE public.photos SET data=jsonb_set(data,'{createdBy}',to_jsonb('deleted-account'::text))
    WHERE data->>'createdBy'=account_id;
  UPDATE public.history SET data=public.runtime_redact_account_attribution(data,account_id)
    WHERE jsonb_path_exists(data,'$.**.createdBy ? (@ == $account)',jsonb_build_object('account',account_id));

  DELETE FROM public.ai_chats WHERE user_id=account_id;
  DELETE FROM public.workflow_stages WHERE actor_id=account_id;
  DELETE FROM public.document_upload_requests WHERE user_id=account_id;
  DELETE FROM public.media_upload_grants WHERE user_id=account_id;
  DELETE FROM public.user_tree_preferences WHERE user_id=account_id;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_anonymize_deleted_account_history(account_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF account_id IS NULL OR account_id=''
    OR current_setting('drevo.account_id',true) IS DISTINCT FROM account_id
    OR NOT EXISTS (SELECT 1 FROM public.deleted_account_tombstones WHERE id=account_id)
  THEN
    RAISE EXCEPTION 'Account deletion context is missing' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.accounts WHERE id=account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account already removed' USING ERRCODE='42501';
  END IF;
  PERFORM public.runtime_anonymize_account_history_rows(account_id);
END $$;

-- Only the authenticated deletion transaction may erase its own comment text.
-- The author lock is shared with the insert trigger in schema 052, so a write
-- that began before deletion either finishes before this UPDATE or observes
-- the committed tombstone and is redacted by the trigger.
CREATE OR REPLACE FUNCTION public.runtime_redact_deleted_account_comments(account_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed bigint;
BEGIN
  IF account_id IS NULL OR account_id=''
    OR current_setting('drevo.account_id',true) IS DISTINCT FROM account_id
    OR NOT EXISTS (
      SELECT 1 FROM public.deleted_account_tombstones
      WHERE id=account_id AND redact_comments=true
    )
  THEN
    RAISE EXCEPTION 'Account comment redaction context is missing' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.accounts WHERE id=account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account already removed' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('drevo-comment:' || account_id,0));
  UPDATE public.person_comments
    SET text='Текст удалён по запросу автора'
    WHERE author_id=account_id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION public.runtime_redact_account_attribution(jsonb,text) OWNER TO %I',current_user);
  EXECUTE format('ALTER FUNCTION public.runtime_anonymize_account_history_rows(text) OWNER TO %I',current_user);
  EXECUTE format('ALTER FUNCTION public.runtime_anonymize_deleted_account_history(text) OWNER TO %I',current_user);
  EXECUTE format('ALTER FUNCTION public.runtime_redact_deleted_account_comments(text) OWNER TO %I',current_user);
END $$;

REVOKE ALL ON FUNCTION public.runtime_redact_account_attribution(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.runtime_anonymize_account_history_rows(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_history(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.runtime_redact_deleted_account_comments(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='site_drevo') THEN
    REVOKE ALL ON FUNCTION public.runtime_redact_account_attribution(jsonb,text) FROM site_drevo;
    REVOKE ALL ON FUNCTION public.runtime_anonymize_account_history_rows(text) FROM site_drevo;
    GRANT EXECUTE ON FUNCTION public.runtime_anonymize_deleted_account_history(text) TO site_drevo;
    GRANT EXECUTE ON FUNCTION public.runtime_redact_deleted_account_comments(text) TO site_drevo;
  END IF;
END $$;

-- Older deletions already have tombstones but no account row. The internal
-- routine is never granted to the app role; this one-time pass is privileged.
DO $$ DECLARE deleted_id text; BEGIN
  FOR deleted_id IN
    SELECT d.id FROM public.deleted_account_tombstones d
    WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id=d.id)
    ORDER BY d.id
  LOOP
    PERFORM public.runtime_anonymize_account_history_rows(deleted_id);
  END LOOP;
END $$;
COMMIT;
