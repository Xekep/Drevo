import { setImmediate } from "node:timers/promises";
import type { StoreDatabase } from "./store-database.ts";

/** Per archive/view, never an authorization or HTTP response cache. */
export function archiveSnapshotReader<T extends { revision: number }>(
  db: StoreDatabase,
  load: () => Promise<T>,
  maximumBytes = 16 * 1024 ** 2,
) {
  type Snapshot = { revision: number; json: string };
  let cached: Snapshot | undefined;
  let pending: { revision: number; value: Promise<Snapshot> } | undefined;
  const revisionQuery = db.prepare(
    "SELECT revision FROM archive WHERE id=1",
    "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id', true)",
  );
  const copy = async (snapshot: Snapshot): Promise<T> => {
    // Deliver each copy in a separate event-loop turn. A resolved shared load
    // otherwise creates every large caller object in one microtask batch before
    // any consumer can release it, multiplying transient RAM during a burst.
    await setImmediate();
    return JSON.parse(snapshot.json) as T;
  };
  return async (): Promise<T> => {
    // A transaction must see its own writes / REPEATABLE READ snapshot. Detached
    // work must still hit the database's expired-context guard, never the cache.
    if (db.inTransaction()) return await load();
    const revision = Number((await revisionQuery.get())?.revision);
    if (!Number.isSafeInteger(revision)) throw new Error("Архив не найден");
    if (cached?.revision === revision) return await copy(cached);
    if (pending?.revision !== revision) {
      const entry = {
        revision,
        value: load().then((snapshot) => ({
          revision: snapshot.revision,
          // Archive hydration contains only persisted JSON values and arrays.
          // Parsing native JSON keeps compact object shapes, unlike v8.deserialize.
          json: JSON.stringify(snapshot),
        })),
      };
      pending = entry;
      // Only the current load can publish: an older slow read must not evict
      // a newer snapshot. Do not retain oversized graphs between requests.
      void entry.value.then(
        (value) => {
          if (pending === entry) {
            cached = value.json.length * 2 <= maximumBytes ? value : undefined;
            pending = undefined;
          }
        },
        () => {
          if (pending === entry) pending = undefined;
        },
      );
    }
    const entry = await pending.value;
    return await copy(entry);
  };
}
