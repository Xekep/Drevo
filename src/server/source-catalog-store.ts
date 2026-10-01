import type { StoreDatabase } from "./store-database.ts";
import type { Family, Source } from "../domain/types.ts";
import { parseCatalogSource, sourceCitation, type CatalogSource } from "../shared/source-catalog.ts";

function parsed(row: Record<string, unknown>) {
  const data = parseCatalogSource(JSON.parse(String(row.data)));
  if (!data) throw new Error("Повреждён источник в каталоге");
  return { ...data, version: Number(row.version) };
}

export function sourceCatalogStore(db: StoreDatabase) {
  const list = async () => (await db.prepare(
    "SELECT data,version FROM source_catalog ORDER BY id",
    "SELECT data,version FROM source_catalog ORDER BY id",
  ).all()).map(parsed);
  const get = async (id: string) => {
    const row = await db.prepare(
      "SELECT data,version FROM source_catalog WHERE id=?",
      "SELECT data,version FROM source_catalog WHERE id=?",
    ).get(id);
    return row ? parsed(row) : null;
  };
  const insert = async (source: CatalogSource) => await db.prepare(
    "INSERT INTO source_catalog(id,data,version) VALUES(?,?,1)",
    "INSERT INTO source_catalog(archive_id,id,data,version) VALUES(current_setting('drevo.archive_id', true),?,?,1)",
  ).run(source.id, JSON.stringify(source));
  const update = async (source: CatalogSource, expected: number) => await db.prepare(
    "UPDATE source_catalog SET data=?,version=version+1 WHERE id=? AND version=?",
    "UPDATE source_catalog SET data=?,version=version+1 WHERE id=? AND version=?",
  ).run(JSON.stringify(source), source.id, expected);
  const remove = async (id: string, expected: number) => await db.prepare(
    "DELETE FROM source_catalog WHERE id=? AND version=?",
    "DELETE FROM source_catalog WHERE id=? AND version=?",
  ).run(id, expected);
  const documentIdsExist = async (ids: string[]) => {
    for (const id of ids)
      if (!await db.prepare("SELECT 1 FROM documents WHERE id=?", "SELECT 1 FROM documents WHERE id=?").get(id))
        return false;
    return true;
  };
  return { list, get, insert, update, remove, documentIdsExist };
}

export function allCitations(family: Family): Source[] {
  return family.people.flatMap((person) => [
    ...person.sources,
    ...(person.events || []).flatMap((event) => event.sources || []),
  ]);
}

/** Archive writes may retain legacy inline citations, but catalog links must be local. */
export async function assertCatalogLinks(db: StoreDatabase, family: Family) {
  const catalog = sourceCatalogStore(db);
  const entries = new Map<string, Awaited<ReturnType<typeof catalog.get>>>();
  for (const citation of allCitations(family)) {
    if (!citation.catalogId) continue;
    if (!entries.has(citation.catalogId))
      entries.set(citation.catalogId, await catalog.get(citation.catalogId));
    const entry = entries.get(citation.catalogId);
    if (!entry) throw new Error("Источник отсутствует в этом архиве");
    if (citation.documentId && !entry.documentIds.includes(citation.documentId))
      throw new Error("Документ цитаты отсутствует у источника");
  }
}

export async function hydrateCatalogCitations(db: StoreDatabase, family: Family) {
  if (!allCitations(family).some((source) => source.catalogId)) return family;
  const entries = new Map((await sourceCatalogStore(db).list()).map((source) => [source.id, source]));
  const resolve = (source: Source): Source => {
    const entry = source.catalogId && entries.get(source.catalogId);
    if (!entry) return source;
    if (source.documentId && !entry.documentIds.includes(source.documentId))
      throw new Error("Документ цитаты отсутствует у источника");
    const retainedDocument = source.documentId;
    return { ...sourceCitation(entry),
      ...(source.documentPage && retainedDocument ? { documentPage: source.documentPage } : {}),
      ...(retainedDocument ? { documentId: retainedDocument } : {}),
    };
  };
  for (const person of family.people) {
    person.sources = person.sources.map(resolve);
    for (const event of person.events || [])
      if (event.sources) event.sources = event.sources.map(resolve);
  }
  return family;
}
