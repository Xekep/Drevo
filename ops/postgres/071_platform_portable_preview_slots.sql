-- Platform-wide admission for staged .drevo previews. Only opaque stage tokens,
-- archive IDs and expiry are stored; the table has no archive RLS scope.
CREATE TABLE IF NOT EXISTS platform_portable_preview_slots (
  token text PRIMARY KEY,
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_portable_preview_slots_expiry
  ON platform_portable_preview_slots(expires_at);
REVOKE ALL ON TABLE platform_portable_preview_slots FROM PUBLIC;

CREATE OR REPLACE FUNCTION runtime_portable_preview_slot_sync()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  now_ms bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.kind='drevo' THEN
      DELETE FROM public.platform_portable_preview_slots
        WHERE token=OLD.token AND archive_id=OLD.archive_id;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.kind='drevo' AND NEW.kind<>'drevo' THEN
    DELETE FROM public.platform_portable_preview_slots
      WHERE token=OLD.token AND archive_id=OLD.archive_id;
  END IF;
  IF NEW.kind<>'drevo' THEN RETURN NEW; END IF;

  IF TG_OP='UPDATE' THEN
    UPDATE public.platform_portable_preview_slots
      SET expires_at=NEW.expires_at
      WHERE token=NEW.token AND archive_id=NEW.archive_id;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;

  -- Held only until this stage statement commits, never while reading the ZIP.
  PERFORM pg_advisory_xact_lock(186743294);
  now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  DELETE FROM public.platform_portable_preview_slots WHERE expires_at<=now_ms;
  IF (SELECT count(*) FROM public.platform_portable_preview_slots) >= 2 THEN
    RAISE EXCEPTION 'Portable preview capacity reached' USING ERRCODE='P5502';
  END IF;
  INSERT INTO public.platform_portable_preview_slots(token,archive_id,expires_at)
    VALUES(NEW.token,NEW.archive_id,NEW.expires_at);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION runtime_portable_preview_slot_sync() FROM PUBLIC;

DROP TRIGGER IF EXISTS portable_preview_slots_sync ON workflow_stages;
CREATE TRIGGER portable_preview_slots_sync
AFTER INSERT OR UPDATE OR DELETE ON workflow_stages
FOR EACH ROW EXECUTE FUNCTION runtime_portable_preview_slot_sync();

-- Archive startup registers any live stages created before this migration.
