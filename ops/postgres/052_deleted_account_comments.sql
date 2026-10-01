-- An account can choose to erase its own discussion text on deletion. The
-- tombstone keeps that choice for writes which were already in flight.
ALTER TABLE deleted_account_tombstones
  ADD COLUMN IF NOT EXISTS redact_comments boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_deleted_comment_author()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE redact boolean;
BEGIN
  IF NEW.author_id='deleted-account' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('drevo-comment:' || NEW.author_id,0));
  -- The same provider identity may register again. A live account is a new
  -- author; old deleted-account rows remain unlinked to it.
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id=NEW.author_id) THEN
    RETURN NEW;
  END IF;
  SELECT redact_comments INTO redact
    FROM public.deleted_account_tombstones WHERE id=NEW.author_id;
  IF FOUND THEN
    NEW.author_id := 'deleted-account';
    NEW.author_name := 'Удалённый участник';
    IF redact THEN NEW.text := 'Текст удалён по запросу автора'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_deleted_comment_author ON person_comments;
CREATE TRIGGER guard_deleted_comment_author
  BEFORE INSERT OR UPDATE OF author_id ON person_comments
  FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_comment_author();
