import type { StoreDatabase } from "./store-database.ts";
import type { Person } from "../domain/types.ts";
import { createPeopleSearch } from "../domain/people-search.ts";

/** Короткие ответы AJAX; записи перечитываются только после изменения архива. */
export function peopleSearchStore(db: StoreDatabase) {
  let revision = -1,
    search = createPeopleSearch([]);
  return async (query: string, visible?: ReadonlySet<string>) => {
    const current = Number(
      (await db
        .prepare(
          "SELECT revision FROM archive WHERE id=1",
          "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id', true)",
        )
        .get())!.revision,
    );
    if (current !== revision) {
      const people = (
        await db
          .prepare("SELECT data FROM people", "SELECT data FROM people")
          .all()
      ).map((row) => JSON.parse(String(row.data)) as Person);
      search = createPeopleSearch(people);
      revision = current;
    }
    return search(query, visible);
  };
}
