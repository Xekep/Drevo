-- Authoritative original-byte counters. Statement transition tables keep
-- multi-row inserts, mixed UPSERT and ON CONFLICT DO NOTHING exact.
CREATE TABLE IF NOT EXISTS archive_media_storage_usage (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  files bigint NOT NULL CHECK(files>=0),
  bytes bigint NOT NULL CHECK(bytes>=0)
);
ALTER TABLE archive_media_storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_media_storage_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON archive_media_storage_usage;
CREATE POLICY archive_scope ON archive_media_storage_usage
  USING (archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id',true));

CREATE OR REPLACE FUNCTION drevo_media_usage_initialize(target text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.archive_media_storage_usage WHERE archive_id=target) THEN RETURN; END IF;
  -- Serialize the baseline with archive writers before any rows change. This
  -- also makes first-use reads safe against a concurrent insert/update/delete.
  PERFORM id FROM public.archives WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.archive_media_storage_usage WHERE archive_id=target) THEN RETURN; END IF;
  INSERT INTO public.archive_media_storage_usage(archive_id,files,bytes)
    SELECT target,count(*),coalesce(sum(size_bytes),0)
      FROM public.media_originals WHERE archive_id=target
    ON CONFLICT(archive_id) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION drevo_media_usage_before()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
  PERFORM public.drevo_media_usage_initialize(current_setting('drevo.archive_id',true));
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION drevo_media_usage_delta(target text, file_delta bigint, byte_delta bigint)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
  -- Archive deletion cascades both tables; never recreate a deleted parent.
  IF NOT EXISTS(SELECT 1 FROM public.archives WHERE id=target) THEN RETURN; END IF;
  UPDATE public.archive_media_storage_usage SET files=files+file_delta,bytes=bytes+byte_delta
    WHERE archive_id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original usage counter not initialized'; END IF;
END $$;

CREATE OR REPLACE FUNCTION drevo_media_usage_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE change record;
BEGIN
  FOR change IN SELECT archive_id,count(*) AS files,sum(size_bytes)::bigint AS bytes FROM new_media GROUP BY archive_id LOOP
    PERFORM public.drevo_media_usage_delta(change.archive_id,change.files,change.bytes);
  END LOOP;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION drevo_media_usage_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE change record;
BEGIN
  FOR change IN SELECT archive_id,-count(*) AS files,(-sum(size_bytes))::bigint AS bytes FROM old_media GROUP BY archive_id LOOP
    PERFORM public.drevo_media_usage_delta(change.archive_id,change.files,change.bytes);
  END LOOP;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION drevo_media_usage_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE change record;
BEGIN
  FOR change IN
    SELECT archive_id,sum(files)::bigint AS files,sum(bytes)::bigint AS bytes FROM (
      SELECT archive_id,1 AS files,size_bytes AS bytes FROM new_media
      UNION ALL SELECT archive_id,-1,-size_bytes FROM old_media
    ) delta GROUP BY archive_id
  LOOP
    PERFORM public.drevo_media_usage_delta(change.archive_id,change.files,change.bytes);
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS media_usage_insert ON media_originals;
DROP TRIGGER IF EXISTS media_usage_before ON media_originals;
CREATE TRIGGER media_usage_before BEFORE INSERT OR UPDATE OR DELETE ON media_originals
  FOR EACH STATEMENT EXECUTE FUNCTION drevo_media_usage_before();
CREATE TRIGGER media_usage_insert AFTER INSERT ON media_originals
  REFERENCING NEW TABLE AS new_media FOR EACH STATEMENT EXECUTE FUNCTION drevo_media_usage_insert();
DROP TRIGGER IF EXISTS media_usage_delete ON media_originals;
CREATE TRIGGER media_usage_delete AFTER DELETE ON media_originals
  REFERENCING OLD TABLE AS old_media FOR EACH STATEMENT EXECUTE FUNCTION drevo_media_usage_delete();
DROP TRIGGER IF EXISTS media_usage_update ON media_originals;
CREATE TRIGGER media_usage_update AFTER UPDATE ON media_originals
  REFERENCING OLD TABLE AS old_media NEW TABLE AS new_media FOR EACH STATEMENT EXECUTE FUNCTION drevo_media_usage_update();
