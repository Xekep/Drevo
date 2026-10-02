import type { StoreDatabase } from "./store-database.ts";
import type { Family, FamilyUnion, Person, Source } from "../domain/types.ts";
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
  const page = async (query: string, offset: number, limit: number) => {
    const match = query.toLocaleLowerCase("ru");
    const fields = ["title", "archive", "reference", "fond", "opis", "delo", "sheet"];
    const sqliteText = `drevo_lower(${fields.map((field) =>
      `coalesce(json_extract(data,'$.${field}'),'')`).join(" || ' ' || ")})`;
    const postgresText = `lower(${fields.map((field) =>
      `coalesce(data->>'${field}','')`).join(" || ' ' || ")})`;
    const where = match ? db.kind === "postgres"
      ? ` WHERE strpos(${postgresText}, ?) > 0`
      : ` WHERE instr(${sqliteText}, ?) > 0` : "";
    const args = match ? [match] : [];
    const total = Number((await db.prepare(
      `SELECT count(*) AS count FROM source_catalog${where}`,
      `SELECT count(*) AS count FROM source_catalog${where}`,
    ).get(...args) as { count: number }).count);
    const sources = (await db.prepare(
      `SELECT data,version FROM source_catalog${where} ORDER BY id LIMIT ? OFFSET ?`,
      `SELECT data,version FROM source_catalog${where} ORDER BY id LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset)).map(parsed);
    return { sources, total };
  };
  const get = async (id: string) => {
    const row = await db.prepare(
      "SELECT data,version FROM source_catalog WHERE id=?",
      "SELECT data,version FROM source_catalog WHERE id=?",
    ).get(id);
    return row ? parsed(row) : null;
  };
  const insert = async (source: CatalogSource, version = 1) => await db.prepare(
    "INSERT INTO source_catalog(id,data,version) VALUES(?,?,?)",
    "INSERT INTO source_catalog(archive_id,id,data,version) VALUES(current_setting('drevo.archive_id', true),?,?,?)",
  ).run(source.id, JSON.stringify(source), version);
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
  const usesDocument = async (id: string) => !!await db.prepare(
    "SELECT 1 FROM source_catalog WHERE EXISTS (SELECT 1 FROM json_each(data, '$.documentIds') WHERE value=?) LIMIT 1",
    "SELECT 1 FROM source_catalog WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'documentIds') AS document_id(value) WHERE document_id.value=?) LIMIT 1",
  ).get(id);
  return { list, page, get, insert, update, remove, documentIdsExist, usesDocument };
}

export function personCitations(person: Person): Source[] {
  return [
    ...person.sources,
    ...(person.birthDateClaim?.sources || []),
    ...(person.deathDateClaim?.sources || []),
    ...(person.birthPlaceClaim?.sources || []),
    ...(person.deathPlaceClaim?.sources || []),
    ...(person.factAlternatives || []).flatMap((alternative) => alternative.sources),
    ...(person.occupationClaim?.sources || []),
    ...(person.maidenNameClaim?.sources || []),
    ...(person.events || []).flatMap((event) => [
      ...(event.sources || []), ...(event.dateClaim?.sources || []),
      ...(event.placeClaim?.sources || []),
    ]),
  ];
}

export function unionCitations(union: FamilyUnion): Source[] {
  return [
    ...(union.sources || []),
    ...(union.formation?.sources || []),
    ...(union.ending?.sources || []),
    ...(union.divorce?.sources || []),
    ...(union.ongoing?.sources || []),
  ];
}

export function allCitations(family: Family): Source[] {
  return [
    ...family.people.flatMap(personCitations),
    ...(family.unions || []).flatMap(unionCitations),
    ...(family.links || []).flatMap((link) => link.sources || []),
  ];
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
    if (person.birthDateClaim)
      person.birthDateClaim.sources = person.birthDateClaim.sources.map(resolve);
    if (person.deathDateClaim)
      person.deathDateClaim.sources = person.deathDateClaim.sources.map(resolve);
    if (person.birthPlaceClaim)
      person.birthPlaceClaim.sources = person.birthPlaceClaim.sources.map(resolve);
    if (person.deathPlaceClaim)
      person.deathPlaceClaim.sources = person.deathPlaceClaim.sources.map(resolve);
    for (const alternative of person.factAlternatives || [])
      alternative.sources = alternative.sources.map(resolve);
    if (person.occupationClaim)
      person.occupationClaim.sources = person.occupationClaim.sources.map(resolve);
    if (person.maidenNameClaim)
      person.maidenNameClaim.sources = person.maidenNameClaim.sources.map(resolve);
    for (const event of person.events || []) {
      if (event.sources) event.sources = event.sources.map(resolve);
      if (event.dateClaim) event.dateClaim.sources = event.dateClaim.sources.map(resolve);
      if (event.placeClaim) event.placeClaim.sources = event.placeClaim.sources.map(resolve);
    }
  }
  for (const union of family.unions || []) {
    if (union.sources) union.sources = union.sources.map(resolve);
    for (const milestone of [union.formation, union.ending, union.divorce, union.ongoing])
      if (milestone?.sources) milestone.sources = milestone.sources.map(resolve);
  }
  for (const link of family.links || [])
    if (link.sources) link.sources = link.sources.map(resolve);
  return family;
}
