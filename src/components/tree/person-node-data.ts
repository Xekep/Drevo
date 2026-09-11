import type { Person } from "../../domain/types.ts";

export type PersonNodeData = {
  person: Person;
  collapsed: boolean;
  childrenCount: number;
  dimmed: boolean;
  household?: boolean;
  occurrences?: number;
  familyFocus?: boolean;
  anchor?: boolean;
  hiddenRelatives?: number;
  expanded?: boolean;
};

/** Поля, от которых действительно зависит внутренняя карточка ReactFlow. */
export function samePersonNodeData(a: PersonNodeData, b: PersonNodeData) {
  return (
    a.person === b.person &&
    a.collapsed === b.collapsed &&
    a.childrenCount === b.childrenCount &&
    a.dimmed === b.dimmed &&
    a.household === b.household &&
    a.occurrences === b.occurrences &&
    a.familyFocus === b.familyFocus &&
    a.anchor === b.anchor &&
    a.hiddenRelatives === b.hiddenRelatives &&
    a.expanded === b.expanded
  );
}
