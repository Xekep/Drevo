import type { StoreDatabase } from "./store-database.ts";
import type { Person } from "../domain/types.ts";
import { createPeopleSearch } from "../domain/people-search.ts";
import { archiveSnapshotBudget } from "./archive-read-cache.ts";

/** Search indexes compete with snapshots/visibility for one process budget. */
export function peopleSearchStore(
  db: StoreDatabase,
  budget = archiveSnapshotBudget(16 * 1024 ** 2),
) {
  type Index = {
    revision: number;
    search: ReturnType<typeof createPeopleSearch>;
    bytes: number;
  };
  const key = Symbol("people search index");
  const revisionQuery = db.prepare(
    "SELECT revision FROM archive WHERE id=1",
    "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id',true)",
  );
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
  const rowsQuery = db.prepare(
    `SELECT json_object(${fields.map((field) => `'${field}',json_extract(data,'$.${field}')`).join(",")}) AS data FROM people`,
    `SELECT jsonb_build_object(${fields.map((field) => `'${field}',data->'${field}'`).join(",")}) AS data FROM people`,
  );
  let pending: { revision: number; value: Promise<Index> } | undefined;
  let closed = false;
  const revision = async () => {
    const value = Number((await revisionQuery.get())?.revision);
    if (!Number.isSafeInteger(value))
      throw new Error("Archive revision is unavailable");
    return value;
  };
  const load = () =>
    db.transaction(async () => {
      const current = await revision();
      const rows = await rowsQuery.all();
      return {
        revision: current,
        search: createPeopleSearch(
          rows.map((row) => JSON.parse(String(row.data)) as Person),
        ),
        // Retained cards + normalized names + sort entries + object/array slots.
        // Conservative accounted bytes, not an RSS/heap measurement.
        bytes:
          128 +
          rows.reduce(
            (size, row) => size + String(row.data).length * 8 + 512,
            0,
          ),
      };
    }, true);
  const read = async (query: string, visible?: ReadonlySet<string>) => {
    const current = await revision();
    // Arbitrary writers see their own data and cannot poison committed indexes.
    if (!db.canReuseGraphCache()) return (await load()).search(query, visible);
    const known = budget.getDerived<Index>(key);
    if (known?.revision === current) return known.search(query, visible);
    if (pending?.revision !== current)
      pending = { revision: current, value: load() };
    const entry = pending;
    try {
      let built = await entry.value;
      // A matching revision is required when joining a different transaction's
      // load. Its snapshot may have started after our REPEATABLE READ snapshot.
      if (built.revision !== current && db.inTransaction())
        built = await load();
      if (pending === entry && !closed) {
        const latest = budget.getDerived<Index>(key);
        if (!latest || latest.revision <= built.revision)
          budget.setDerived(key, built, built.bytes);
      }
      return built.search(query, visible);
    } finally {
      if (pending === entry) pending = undefined;
    }
  };
  return Object.assign(read, {
    close() {
      closed = true;
      pending = undefined;
      budget.remove(key);
    },
  });
}
