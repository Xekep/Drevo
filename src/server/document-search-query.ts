import { fullName } from "../domain/index.ts";
import type { Person } from "../domain/types.ts";
import type { StoreDatabase } from "./store-database.ts";

type SearchPerson = Pick<Person, "id" | "name" | "surname" | "patronymic">;

/** Names are sufficient for catalogue search; never transfer whole biographies. */
export async function documentSearchPeople(db: Pick<StoreDatabase, "prepare">): Promise<SearchPerson[]> {
  const rows = await db.prepare(
    `SELECT p.id,json_extract(p.data,'$.name') AS name,
      json_extract(p.data,'$.surname') AS surname,
      json_extract(p.data,'$.patronymic') AS patronymic
     FROM (SELECT DISTINCT person_id FROM document_people) dp JOIN people p ON p.id=dp.person_id`,
    `SELECT p.id,p.data->>'name' AS name,p.data->>'surname' AS surname,
      p.data->>'patronymic' AS patronymic
     FROM (SELECT DISTINCT person_id FROM document_people) dp JOIN people p ON p.id=dp.person_id`,
  ).all();
  return rows.map(row => ({
    id: String(row.id), name: String(row.name ?? ""),
    surname: String(row.surname ?? ""), patronymic: String(row.patronymic ?? ""),
  }));
}

export function normalizeDocumentQuery(value: string): string {
  return value
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .trim()
    .replace(/\s+/gu, " ");
}

/** Keep filtering and relevance ahead of SQL pagination on both databases. */
export function documentSearchQuery(
  query: string,
  people: SearchPerson[],
  kind: "sqlite" | "postgres",
) {
  const terms = [...new Set(query.split(" "))];
  const matching: string[] = [],
    exact: string[] = [];
  for (const person of people) {
    const name = normalizeDocumentQuery(fullName(person));
    if (!terms.every((term) => name.includes(term))) continue;
    matching.push(person.id);
    const words = new Set(name.match(/[\p{L}\p{N}]+/gu) || []);
    if (terms.every((term) => words.has(term))) exact.push(person.id);
  }
  const contains = (field: string) =>
    kind === "postgres" ? `strpos(${field}, ?) > 0` : `instr(${field}, ?) > 0`;
  const personMatch = `EXISTS (SELECT 1 FROM document_people dp WHERE dp.document_id=d.id AND dp.person_id IN (SELECT value FROM ${kind === "postgres" ? "jsonb_array_elements_text(?::jsonb)" : "json_each(?)"}))`;
  // title_search already contains lowercase title followed by metadata. Keep
  // existing records searchable without a migration or loading the catalogue.
  const text = "replace(d.title_search, 'ё', 'е')";
  const title = `substr(${text}, 1, length(d.title))`;
  return {
    condition: `((${terms.map(() => contains(text)).join(" AND ")}) OR ${personMatch})`,
    args: [...terms, JSON.stringify(matching)],
    order: `CASE WHEN ${title}=? OR ${personMatch} THEN 0 WHEN ${terms.map(() => contains(title)).join(" AND ")} THEN 1 WHEN ${personMatch} THEN 2 ELSE 3 END`,
    orderArgs: [
      query,
      JSON.stringify(exact),
      ...terms,
      JSON.stringify(matching),
    ],
  };
}
