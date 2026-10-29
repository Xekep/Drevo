import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import {
  MAX_INCREMENTAL_LAYOUT_PEOPLE,
  type TreeNodeSize,
} from "./tree-layout-constants.ts";

/** Historical hints have their own budget; the cold portfolio still uses 200. */
export const FAMILY_HISTORY_LIMITS = {
  people: 400,
  changedPeople: 4,
  relations: 8,
};

/** Larger scenes may retain their slots for a small edit, not a bulk replacement. */
export function canUseFamilyLayoutHistory(
  people: LayoutPerson[],
  previous: TreeGeometry | undefined,
  reverse: boolean,
  size: TreeNodeSize,
) {
  if (
    !previous ||
    previous.mode !== "generations" ||
    previous.reverse !== reverse ||
    (previous.nodeSize &&
      (previous.nodeSize.width !== size.width ||
        previous.nodeSize.height !== size.height))
  )
    return false;
  if (people.length <= MAX_INCREMENTAL_LAYOUT_PEOPLE) return true;
  if (
    people.length > FAMILY_HISTORY_LIMITS.people ||
    previous.positions.length > FAMILY_HISTORY_LIMITS.people ||
    !previous.nodeSize ||
    !previous.occurrences?.length ||
    !previous.branches ||
    !previous.generationBands?.length
  )
    return false;
  const old = new Set(previous.occurrences.map((o) => o.personId));
  const current = new Set(people.map((p) => p.id));
  // Repeated occurrences have more complicated projection dependencies.
  if (
    old.size !== previous.occurrences.length ||
    current.size !== people.length ||
    previous.positions.length !== old.size ||
    new Set(previous.positions.map(([id]) => id)).size !==
      previous.positions.length ||
    previous.positions.some(
      ([id, p]) =>
        !old.has(id) || !Number.isFinite(p.x) || !Number.isFinite(p.y),
    )
  )
    return false;
  const changed =
    [...old].filter((id) => !current.has(id)).length +
    [...current].filter((id) => !old.has(id)).length;
  if (changed > FAMILY_HISTORY_LIMITS.changedPeople) return false;
  const key = (type: "parent" | "spouse", from: string, to: string) =>
    JSON.stringify(
      type === "spouse" ? [type, ...[from, to].sort()] : [type, from, to],
    );
  const before = new Set(
    previous.branches.flatMap((b) =>
      b.relations.map((r) => key(r.type, r.from, r.to)),
    ),
  );
  const after = new Set(
    people.flatMap((p) => [
      ...p.parents.map((from) => key("parent", from, p.id)),
      ...p.spouses.map((to) => key("spouse", p.id, to)),
    ]),
  );
  let difference = 0;
  for (const relation of before)
    if (!after.has(relation) && ++difference > FAMILY_HISTORY_LIMITS.relations)
      return false;
  for (const relation of after)
    if (!before.has(relation) && ++difference > FAMILY_HISTORY_LIMITS.relations)
      return false;
  return true;
}
