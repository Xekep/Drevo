import type { DatabaseSync } from "node:sqlite";
import type { Person } from "../domain/types.ts";
import { findPeople } from "../domain/people-search.ts";

/** Короткие ответы AJAX; записи перечитываются только после изменения архива. */
export function peopleSearchStore(db: DatabaseSync) {
  let revision = -1,
    people: Person[] = [];
  return (query: string) => {
    const current = Number(
      db.prepare("SELECT revision FROM archive WHERE id=1").get()!.revision,
    );
    if (current !== revision) {
      people = db
        .prepare("SELECT data FROM people")
        .all()
        .map((row) => JSON.parse(String(row.data)) as Person);
      revision = current;
    }
    return findPeople(people, query);
  };
}
