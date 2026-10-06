/** Concrete reverse projection; SQLite keeps its portable legacy JSON scan. */
export function citationCandidateQuery(
  kind: "person" | "union" | "relation",
  column: "data" | "sources",
  ids: string[],
) {
  return {
    sqlite: ids.map(() => `${column} LIKE ?`).join(" OR "),
    postgres: `id IN (SELECT entity_id FROM document_citation_refs
      WHERE archive_id=current_setting('drevo.archive_id',true) AND kind='${kind}'
      AND document_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)))`,
    sqliteArgs: ids.map((id) => `%${id}%`),
    postgresArgs: [JSON.stringify(ids)],
  };
}
