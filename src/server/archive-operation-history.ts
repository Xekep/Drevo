import type { StoreDatabase } from "./store-database.ts";
import {
  archiveChanges,
  applyArchiveChanges,
  type Change,
} from "../domain/changes.ts";
import { validateFamily } from "../domain/validation.ts";
import type { Family } from "../domain/types.ts";

/** One backward pass through retained snapshots/deltas, including ABA edits. */
export async function readArchiveOperation(
  db: StoreDatabase,
  current: { revision: number; family: Family },
  revision: number,
) {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > current.revision
  )
    throw new Error("Некорректная версия архива");
  const rows = await db
    .prepare(
      "SELECT revision FROM history WHERE revision>=? ORDER BY revision DESC",
      "SELECT revision FROM history WHERE revision>=? ORDER BY revision DESC",
    )
    .all(revision - 1);
  let state = current.family;
  let nextRevision = current.revision;
  let after: Family | undefined =
    revision === current.revision ? state : undefined;
  const later = new Map<string, Change>();
  for (const row of rows) {
    const previousRevision = Number(row.revision);
    if (previousRevision !== nextRevision - 1) break;
    // Read one retained snapshot at a time: fifty full imports must not become
    // fifty resident JSON blobs just to preview a single undo.
    const stored = await db
      .prepare(
        "SELECT data FROM history WHERE revision=?",
        "SELECT data FROM history WHERE revision=?",
      )
      .get(previousRevision);
    if (!stored) break;
    const saved = JSON.parse(String(stored.data));
    const delta = [
      "drevo-person-patches-v1",
      "drevo-archive-changes-v1",
    ].includes(saved.format);
    const previous: Family = delta
      ? applyArchiveChanges(state, saved.changes, "local").family
      : saved;
    if (previousRevision >= revision) {
      const changes: Change[] = delta
        ? saved.changes
        : archiveChanges(previous, state);
      for (const { collection, id, field } of changes)
        later.set(JSON.stringify([collection, id, field]), {
          collection,
          id,
          field,
          before: undefined,
          after: undefined,
        });
    }
    if (previousRevision === revision) after = previous;
    if (previousRevision === revision - 1 && after)
      return {
        before: validateFamily(previous),
        after: validateFamily(after),
        laterChanges: [...later.values()],
      };
    state = previous;
    nextRevision = previousRevision;
  }
  throw new Error("Версия больше не хранится в истории");
}
