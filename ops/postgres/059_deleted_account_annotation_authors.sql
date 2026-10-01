-- Privileged migration: run as the owner of the account deletion functions
-- (SUPERUSER/BYPASSRLS), after 058 and before activating this app release.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Account annotation anonymization requires BYPASSRLS';
  END IF;
  IF to_regprocedure('public.runtime_anonymize_deleted_account_unions(text)') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid=to_regprocedure('public.runtime_anonymize_deleted_account_history(text)')
        AND r.rolname=current_user
    ) THEN
    RAISE EXCEPTION 'Install 058 as the account history function owner first';
  END IF;
END $$;

-- Wait for in-flight deletions and prevent concurrent re-registration while
-- classifying old tombstones for the one-time backfill.
LOCK TABLE public.accounts IN EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.runtime_anonymize_deleted_account_annotations(account_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF account_id IS NULL OR account_id='' OR NOT EXISTS (
    SELECT 1 FROM public.deleted_account_tombstones WHERE id=account_id
  ) THEN
    RAISE EXCEPTION 'No deletion tombstone for account';
  END IF;
  -- Annotation writes lock their archive before reading documents. Membership
  -- covers a first uncommitted annotation that is not visible to this query.
  PERFORM 1 FROM public.archives
    WHERE id IN (
      SELECT archive_id FROM public.archive_memberships WHERE user_id=account_id
      UNION
      SELECT d.archive_id FROM public.documents d
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(d.annotations::jsonb) item
        WHERE item->>'authorId'=account_id)
    ) ORDER BY id FOR UPDATE;
  UPDATE public.documents d SET annotations=(
    SELECT COALESCE(jsonb_agg(
      CASE WHEN item->>'authorId'=account_id THEN
        jsonb_set(jsonb_set(item,'{authorId}',to_jsonb('deleted-account'::text)),
          '{authorName}',to_jsonb('Удалённый участник'::text))
      ELSE item END ORDER BY ordinal), '[]'::jsonb)::text
    FROM jsonb_array_elements(d.annotations::jsonb) WITH ORDINALITY AS parts(item,ordinal)
  ) WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(d.annotations::jsonb) item
    WHERE item->>'authorId'=account_id);
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
  PERFORM public.runtime_anonymize_deleted_account_unions(account_id);
  PERFORM public.runtime_anonymize_deleted_account_annotations(account_id);
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION public.runtime_anonymize_deleted_account_annotations(text) OWNER TO %I',current_user);
  EXECUTE format('ALTER FUNCTION public.runtime_anonymize_deleted_account_history(text) OWNER TO %I',current_user);
END $$;
REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_annotations(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_history(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='site_drevo') THEN
    REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_annotations(text) FROM site_drevo;
    GRANT EXECUTE ON FUNCTION public.runtime_anonymize_deleted_account_history(text) TO site_drevo;
  END IF;
END $$;

-- Only IDs whose deletion tombstone has no current account are unambiguous.
-- An ID re-used by a live account needs separate review, not automatic change.
DO $$ BEGIN
  PERFORM 1 FROM public.archives WHERE id IN (
    SELECT d.archive_id FROM public.documents d
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(d.annotations::jsonb) item
      JOIN public.deleted_account_tombstones t ON t.id=item->>'authorId'
      WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id=t.id)
    )
  ) ORDER BY id FOR UPDATE;
END $$;
UPDATE public.documents d SET annotations=(
  SELECT COALESCE(jsonb_agg(
    CASE WHEN EXISTS (
      SELECT 1 FROM public.deleted_account_tombstones t
      WHERE t.id=item->>'authorId'
        AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id=t.id)
    ) THEN jsonb_set(jsonb_set(item,'{authorId}',to_jsonb('deleted-account'::text)),
      '{authorName}',to_jsonb('Удалённый участник'::text))
    ELSE item END ORDER BY ordinal), '[]'::jsonb)::text
  FROM jsonb_array_elements(d.annotations::jsonb) WITH ORDINALITY AS parts(item,ordinal)
) WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(d.annotations::jsonb) item
  JOIN public.deleted_account_tombstones t ON t.id=item->>'authorId'
  WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id=t.id)
);
COMMIT;
