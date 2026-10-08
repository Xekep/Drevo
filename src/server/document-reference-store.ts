import type { StoreDatabase } from "./store-database.ts";
import type {
  FamilyLink,
  FamilyUnion,
  Person,
  Source,
} from "../domain/types.ts";
import { citationCandidateQuery } from "./document-citation-query.ts";
import { personCitations, unionCitations } from "./source-catalog-store.ts";

/** SQL candidates and exact citation membership; HTTP owns authorization and delivery. */
export function documentReferenceStore(db: StoreDatabase) {
  const linkedPersons = async (ids: string[]) => {
    if (!ids.length) return [] as Person[];
    const rows = await db
      .prepare(
        "SELECT id,data FROM people WHERE id IN (SELECT value FROM json_each(?))",
        "SELECT id,data FROM people WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))",
      )
      .all(JSON.stringify([...new Set(ids)]));
    return rows.map(
      (row) =>
        (typeof row.data === "string"
          ? JSON.parse(row.data)
          : row.data) as Person,
    );
  };

  const citedEntities = async (documentIds: string[]) => {
    if (!documentIds.length)
      return {
        people: [] as Person[],
        unions: [] as FamilyUnion[],
        links: [] as FamilyLink[],
        parents: [] as Array<{ from: string; to: string; sources: Source[] }>,
      };
    // One candidate scan per page (at most 100 document IDs), never one scan
    // per listed document. The reader checks exact documentId after parsing.
    const personQuery = citationCandidateQuery("person", "data", documentIds);
    const unionQuery = citationCandidateQuery("union", "data", documentIds);
    const relationQuery = citationCandidateQuery(
      "relation",
      "sources",
      documentIds,
    );
    const args = (query: ReturnType<typeof citationCandidateQuery>) =>
      db.kind === "postgres" ? query.postgresArgs : query.sqliteArgs;
    const parse = <T>(value: unknown): T =>
      (typeof value === "string" ? JSON.parse(value) : value) as T;
    const people = (
      await db
        .prepare(
          `SELECT data FROM people WHERE ${personQuery.sqlite}`,
          `SELECT data FROM people WHERE ${personQuery.postgres}`,
        )
        .all(...args(personQuery))
    ).map((row) => parse<Person>(row.data));
    const unions = (
      await db
        .prepare(
          `SELECT data FROM family_unions WHERE ${unionQuery.sqlite}`,
          `SELECT data FROM family_unions WHERE ${unionQuery.postgres}`,
        )
        .all(...args(unionQuery))
    ).map((row) => parse<FamilyUnion>(row.data));
    const links = (
      await db
        .prepare(
          `SELECT id,source,target,type,sources FROM relations WHERE type NOT IN ('parent','spouse') AND (${relationQuery.sqlite})`,
          `SELECT id,source,target,type,sources FROM relations WHERE type NOT IN ('parent','spouse') AND (${relationQuery.postgres})`,
        )
        .all(...args(relationQuery))
    ).map((row) => ({
      id: String(row.id),
      from: String(row.source),
      to: String(row.target),
      type: row.type as FamilyLink["type"],
      sources: parse<Source[]>(row.sources),
    }));
    const parents = (
      await db
        .prepare(
          `SELECT source,target,sources FROM relations WHERE type='parent' AND (${relationQuery.sqlite})`,
          `SELECT source,target,sources FROM relations WHERE type='parent' AND (${relationQuery.postgres})`,
        )
        .all(...args(relationQuery))
    ).map((row) => ({
      from: String(row.source),
      to: String(row.target),
      sources: parse<Source[]>(row.sources),
    }));
    return { people, unions, links, parents };
  };

  const referencingPeople = async (documentId: string) => {
    const personQuery = citationCandidateQuery("person", "data", [documentId]);
    const unionQuery = citationCandidateQuery("union", "data", [documentId]);
    const relationQuery = citationCandidateQuery("relation", "sources", [
      documentId,
    ]);
    const args = (query: ReturnType<typeof citationCandidateQuery>) =>
      db.kind === "postgres" ? query.postgresArgs : query.sqliteArgs;
    // The citation lives inside person JSON until sources become first-class rows.
    // Narrow the occasional delete check before inspecting nested sources.
    const rows = await db
      .prepare(
        `SELECT id,data FROM people WHERE ${personQuery.sqlite}`,
        `SELECT id,data FROM people WHERE ${personQuery.postgres}`,
      )
      .all(...args(personQuery));
    const people = rows.flatMap((row) => {
      const person = (
        typeof row.data === "string" ? JSON.parse(row.data) : row.data
      ) as Person;
      const linked = personCitations(person).some(
        (source) => source.documentId === documentId,
      );
      return linked ? [String(row.id)] : [];
    });
    const unions = await db
      .prepare(
        `SELECT data FROM family_unions WHERE ${unionQuery.sqlite}`,
        `SELECT data FROM family_unions WHERE ${unionQuery.postgres}`,
      )
      .all(...args(unionQuery));
    for (const row of unions) {
      const union = (
        typeof row.data === "string" ? JSON.parse(row.data) : row.data
      ) as FamilyUnion;
      if (
        unionCitations(union).some((source) => source.documentId === documentId)
      )
        people.push(...union.participants);
    }
    const links = await db
      .prepare(
        `SELECT source,target,sources FROM relations WHERE type <> 'spouse' AND (${relationQuery.sqlite})`,
        `SELECT source,target,sources FROM relations WHERE type <> 'spouse' AND (${relationQuery.postgres})`,
      )
      .all(...args(relationQuery));
    for (const row of links) {
      const sources = (
        typeof row.sources === "string" ? JSON.parse(row.sources) : row.sources
      ) as Source[];
      if (sources.some((source) => source.documentId === documentId))
        people.push(String(row.source), String(row.target));
    }
    return [...new Set(people)];
  };

  return { linkedPersons, citedEntities, referencingPeople };
}
