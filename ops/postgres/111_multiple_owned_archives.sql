-- Basic accounts keep one tree; current platform staff may own several.
-- Account locking also serializes transfers and creation after removing the
-- unconditional unique index. NOWAIT avoids reversing a caller's lock order.
CREATE OR REPLACE FUNCTION enforce_account_archive_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous_account text; staff boolean; already_owned boolean;
BEGIN
  IF TG_OP='UPDATE' AND NEW.user_id=OLD.user_id THEN RETURN NEW; END IF;
  PERFORM 1 FROM accounts WHERE id=NEW.user_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM platform_admins WHERE account_id=NEW.user_id FOR SHARE NOWAIT;
  staff := FOUND;
  PERFORM 1 FROM platform_researchers WHERE account_id=NEW.user_id FOR SHARE NOWAIT;
  staff := staff OR FOUND;
  IF staff THEN RETURN NEW; END IF;
  previous_account := current_setting('drevo.account_id',true);
  PERFORM set_config('drevo.account_id',NEW.user_id,true);
  SELECT EXISTS(SELECT 1 FROM archive_owners WHERE user_id=NEW.user_id
    AND archive_id<>NEW.archive_id) INTO already_owned;
  PERFORM set_config('drevo.account_id',coalesce(previous_account,''),true);
  IF already_owned THEN
    RAISE EXCEPTION 'У аккаунта уже есть собственное древо'
      USING ERRCODE='23505', CONSTRAINT='archive_owners_basic_account_limit';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enforce_account_archive_limit ON archive_owners;
CREATE TRIGGER enforce_account_archive_limit BEFORE INSERT OR UPDATE OF user_id
  ON archive_owners FOR EACH ROW EXECUTE FUNCTION enforce_account_archive_limit();
DROP INDEX IF EXISTS archive_owners_one_tree_per_user;
CREATE INDEX IF NOT EXISTS archive_owners_by_user ON archive_owners(user_id);
