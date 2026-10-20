import {
  archiveChanges,
  inverseChanges,
  applyArchiveChanges,
  type Change,
} from "./changes.ts";
import { validateFamily } from "./validation.ts";
import type { Family } from "./types.ts";

/** An inverse operation preserves unrelated edits and never forces a conflict. */
export function prepareTransactionUndo(
  before: Family,
  after: Family,
  current: Family,
  laterChanges: Change[] = [],
) {
  const changes = archiveChanges(before, after);
  if (!changes.length)
    throw new Error("В этой операции нет изменений семейных данных");
  const inverse = inverseChanges(changes);
  // Unlike an idempotent save, undo must not silently skip fields already
  // reverted by someone else: the whole original operation is reviewed once.
  const changed = [...laterChanges, ...archiveChanges(after, current)];
  const overlapping = inverse.some((a) =>
    changed.some(
      (b) =>
        a.collection === b.collection &&
        a.id === b.id &&
        (!a.field || !b.field || a.field === b.field),
    ),
  );
  if (overlapping)
    throw new Error(
      "Затронутые сведения изменились после этой операции. Отмена недоступна",
    );
  const merged = applyArchiveChanges(current, inverse);
  if (merged.conflicts.length)
    throw new Error("Отмена конфликтует с текущими сведениями");
  try {
    return { family: validateFamily(merged.family), changes: inverse.length };
  } catch {
    throw new Error(
      "После этой операции появились зависимые связи. Сначала проверьте их вручную",
    );
  }
}
