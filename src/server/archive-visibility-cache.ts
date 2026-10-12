import type { StoreDatabase } from "./store-database.ts";
import type { Family } from "../domain/types.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { visiblePersonIds } from "../domain/tree-access.ts";
import { archiveSnapshotBudget } from "./archive-read-cache.ts";

type Graph = { family: Family; revision: number };

/** Shared by every scoped reader of one runtime. Grants are always supplied fresh.
 * Cache hits are permitted only for committed/read-only graph contexts; writers
 * see their own SQL and can never publish rolled-back cards under a revision. */
export function archiveVisibilityReader(
  db: StoreDatabase,
  load: () => Promise<Graph>,
  budget = archiveSnapshotBudget(16 * 1024 ** 2),
) {
  const graphKey = Symbol("visibility graph");
  const scopes = new Map<string, symbol>();
  const revisionQuery = db.prepare(
    "SELECT revision FROM archive WHERE id=1",
    "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id',true)",
  );
  let closed = false;
  let pending: { revision: number; value: Promise<Graph> } | undefined;
  const graph = async (revision: number) => {
    const known = budget.getDerived<Graph>(graphKey);
    if (known?.revision === revision) return known;
    // A pending load can belong to another REPEATABLE READ snapshot. Joining it
    // is safe only when the actual loaded revision equals this caller's snapshot.
    let value: Graph;
    if (pending?.revision === revision) {
      value = await pending.value;
      if (value.revision === revision) return value;
      return await load();
    }
    const entry = { revision, value: load() };
    pending = entry;
    try {
      value = await entry.value;
      if (!closed && pending === entry && value.revision === revision) {
        // Includes JSON fields, object/array slots and the later visibility walk.
        const size =
          JSON.stringify(value).length * 4 + value.family.people.length * 256;
        const latest = budget.getDerived<Graph>(graphKey);
        // Serve an older transaction's graph without replacing a newer
        // committed index that ordinary current readers are already using.
        if (!latest || latest.revision <= value.revision)
          budget.setDerived(graphKey, value, size);
      }
      return value;
    } finally {
      if (pending === entry) pending = undefined;
    }
  };
  const read = async (user: ArchiveUser): Promise<ReadonlySet<string>> => {
    // Query also enforces expired async-context guards before touching any cache.
    const revision = Number((await revisionQuery.get())?.revision);
    if (!Number.isSafeInteger(revision))
      throw new Error(
        "\u0410\u0440\u0445\u0438\u0432 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d",
      );
    if (!db.canReuseGraphCache())
      return visiblePersonIds((await load()).family, user);
    const scope = JSON.stringify([
      revision,
      user.id,
      user.personId,
      user.treeAccess,
      user.role,
      user.archiveOwner,
      user.globalRole,
    ]);
    const key = scopes.get(scope);
    const known = key ? budget.getDerived<ReadonlySet<string>>(key) : undefined;
    if (known) return known;
    const data = await graph(revision);
    const visible = visiblePersonIds(data.family, user);
    // A read outside a transaction may race a commit. Never key the newer graph
    // under the older revision; HTTP delivery still independently rechecks rights.
    if (!closed && data.revision === revision) {
      const existing = scopes.get(scope);
      const shared = existing
        ? budget.getDerived<ReadonlySet<string>>(existing)
        : undefined;
      if (shared) return shared;
      const symbol = Symbol("visible ids");
      scopes.set(scope, symbol);
      const size =
        scope.length * 2 +
        128 +
        [...visible].reduce((sum, id) => sum + id.length * 2 + 64, 0);
      budget.setDerived(symbol, visible, size, () => {
        if (scopes.get(scope) === symbol) scopes.delete(scope);
      });
    }
    return visible;
  };
  return Object.assign(read, {
    close() {
      closed = true;
      pending = undefined;
      budget.remove(graphKey);
      for (const symbol of [...scopes.values()]) budget.remove(symbol);
      scopes.clear();
    },
  });
}
