import type { StoreDatabase } from "./store-database.ts";
import type { Person } from "../domain/types.ts";
import { createPeopleSearch } from "../domain/people-search.ts";

/** Короткие ответы AJAX; записи перечитываются только после изменения архива. */
export function peopleSearchStore(db: StoreDatabase) {
  let revision = -1,
    search = createPeopleSearch([]);
  let pending:
    | {
        revision: number;
        value: Promise<ReturnType<typeof createPeopleSearch>>;
      }
    | undefined;
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
      if (!pending || pending.revision !== current) {
        const fields = [
          "id",
          "surname",
          "name",
          "patronymic",
          "birth",
          "death",
          "deceased",
          "maidenName",
        ];
        const value = db
          .prepare(
            `SELECT json_object(${fields.map((field) => `'${field}',json_extract(data,'$.${field}')`).join(",")}) AS data FROM people`,
            `SELECT jsonb_build_object(${fields.map((field) => `'${field}',data->'${field}'`).join(",")}) AS data FROM people`,
          )
          .all()
          .then((rows) =>
            createPeopleSearch(
              rows.map((row) => JSON.parse(String(row.data)) as Person),
            ),
          );
        pending = { revision: current, value };
      }
      const entry = pending;
      let built: ReturnType<typeof createPeopleSearch>;
      try {
        built = await entry.value;
      } catch (error) {
        if (pending === entry) pending = undefined;
        throw error;
      }
      if (pending === entry) {
        search = built;
        revision = current;
        pending = undefined;
      }
      return built(query, visible);
    }
    return search(query, visible);
  };
}
