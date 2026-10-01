-- Privileged migration: install as the PostgreSQL owner of the account
-- anonymization functions (SUPERUSER or BYPASSRLS), before activating the
-- matching application release. The app role cannot update all archives
-- through FORCE RLS and must never own this SECURITY DEFINER function.
BEGIN;
-- Hold registration/deletion writes while classifying tombstoned IDs for
-- backfill. A concurrent re-registration cannot slip between the check and
-- the update; live deletions finish after this transaction if necessary.
LOCK TABLE public.accounts IN SHARE MODE;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Account union anonymization requires BYPASSRLS';
  END IF;
  IF to_regprocedure('public.runtime_anonymize_account_history_rows(text)') IS NULL THEN
    RAISE EXCEPTION 'Install account history anonymization before migration 058';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles owner_role ON owner_role.oid=p.proowner
    WHERE p.oid=to_regprocedure('public.runtime_anonymize_deleted_account_history(text)')
      AND owner_role.rolname=current_user
  ) THEN
    RAISE EXCEPTION 'Migration 058 must run as the account history function owner';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_anonymize_deleted_account_unions(account_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF account_id IS NULL OR account_id='' OR NOT EXISTS (
    SELECT 1 FROM public.deleted_account_tombstones WHERE id=account_id
  ) THEN
    RAISE EXCEPTION 'No deletion tombstone for account';
  END IF;
  UPDATE public.family_unions
    SET data=jsonb_set(data,'{createdBy}',to_jsonb('deleted-account'::text))
    WHERE data->>'createdBy'=account_id;
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
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION public.runtime_anonymize_deleted_account_unions(text) OWNER TO %I',current_user);
  EXECUTE format('ALTER FUNCTION public.runtime_anonymize_deleted_account_history(text) OWNER TO %I',current_user);
END $$;
REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_unions(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_history(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='site_drevo') THEN
    REVOKE ALL ON FUNCTION public.runtime_anonymize_deleted_account_unions(text) FROM site_drevo;
    GRANT EXECUTE ON FUNCTION public.runtime_anonymize_deleted_account_history(text) TO site_drevo;
  END IF;
END $$;

-- Only unambiguously deleted IDs are backfilled. A tombstoned ID which has
-- since been re-registered is deliberately left for review: its new rows
-- cannot be distinguished from old rows by ID alone.
UPDATE public.family_unions u
  SET data=jsonb_set(u.data,'{createdBy}',to_jsonb('deleted-account'::text))
  FROM public.deleted_account_tombstones d
  WHERE u.data->>'createdBy'=d.id
    AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id=d.id);
COMMIT;
