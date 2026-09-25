import type { DatabaseSync } from "node:sqlite";
import type { Person } from "../domain/types.ts";
import { createPeopleSearch } from "../domain/people-search.ts";

/** Короткие ответы AJAX; записи перечитываются только после изменения архива. */
export function peopleSearchStore(db: DatabaseSync) {
  let revision = -1,
    search = createPeopleSearch([]);
  return (query: string, visible?: ReadonlySet<string>) => {
    const current = Number(
      db.prepare("SELECT revision FROM archive WHERE id=1").get()!.revision,
    );
    if (current !== revision) {
      const people = db
        .prepare("SELECT data FROM people")
        .all()
        .map((row) => JSON.parse(String(row.data)) as Person);
      search = createPeopleSearch(people);
      revision = current;
    }
    return search(query, visible);
  };
}
