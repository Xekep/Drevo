-- Reverse projection maintained by every SQL writer, including import/restore.
CREATE TABLE IF NOT EXISTS document_citation_refs (
  archive_id text NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('person','union','relation')),
  entity_id text NOT NULL,
  PRIMARY KEY (archive_id,document_id,kind,entity_id)
);
CREATE INDEX IF NOT EXISTS document_citation_refs_entity
  ON document_citation_refs(archive_id,kind,entity_id);
CREATE TABLE IF NOT EXISTS document_citation_index_state (
  archive_id text PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE
);
ALTER TABLE document_citation_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_citation_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_citation_index_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_citation_index_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS archive_scope ON document_citation_refs;
CREATE POLICY archive_scope ON document_citation_refs
  USING (archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id',true));
DROP POLICY IF EXISTS archive_scope ON document_citation_index_state;
CREATE POLICY archive_scope ON document_citation_index_state
  USING (archive_id=current_setting('drevo.archive_id',true))
  WITH CHECK (archive_id=current_setting('drevo.archive_id',true));

CREATE OR REPLACE FUNCTION sync_document_citation_refs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM public.document_citation_refs
      WHERE archive_id=OLD.archive_id AND kind=TG_ARGV[0] AND entity_id=OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  INSERT INTO public.document_citation_refs(archive_id,document_id,kind,entity_id)
    SELECT DISTINCT NEW.archive_id,ref #>> '{}',TG_ARGV[0],NEW.id
    FROM jsonb_path_query(to_jsonb(NEW)->TG_ARGV[1],'$.**.documentId') AS ref
    WHERE jsonb_typeof(ref)='string' AND ref #>> '{}' <> ''
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sync_document_citations ON people;
CREATE TRIGGER sync_document_citations AFTER INSERT OR DELETE OR UPDATE OF data ON people
  FOR EACH ROW EXECUTE FUNCTION sync_document_citation_refs('person','data');
DROP TRIGGER IF EXISTS sync_document_citations ON family_unions;
CREATE TRIGGER sync_document_citations AFTER INSERT OR DELETE OR UPDATE OF data ON family_unions
  FOR EACH ROW EXECUTE FUNCTION sync_document_citation_refs('union','data');
DROP TRIGGER IF EXISTS sync_document_citations ON relations;
CREATE TRIGGER sync_document_citations AFTER INSERT OR DELETE OR UPDATE OF sources ON relations
  FOR EACH ROW EXECUTE FUNCTION sync_document_citation_refs('relation','sources');
