import type { LayoutPerson } from "./tree-layout.ts";
import type { Point } from "./layout-order.ts";
/** Общая поверхность объединяет только соседних супругов или известных со-родителей. */
export function householdBands(
  people: LayoutPerson[],
  positions: Map<string, Point>,
  width: number,
  height: number,
) {
  const groups = new Map([...positions.keys()].map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (groups.get(root) !== root) root = groups.get(root)!;
    while (groups.get(id) !== id) {
      const next = groups.get(id)!;
      groups.set(id, root);
      id = next;
    }
    return root;
  };
  const join = (a: string, b: string) => {
    const x = positions.get(a),
      y = positions.get(b);
    if (x && y && x.y === y.y && Math.abs(x.x - y.x) <= width + 40)
      groups.set(find(b), find(a));
  };
  for (const p of people) {
    for (const spouse of p.spouses) join(p.id, spouse);
    for (const a of p.parents)
      for (const b of p.parents) if (a !== b) join(a, b);
  }
  const members = new Map<string, string[]>();
  for (const id of groups.keys()) {
    const root = find(id),
      list = members.get(root) || [];
    list.push(id);
    members.set(root, list);
  }
  return [...members.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => {
      let id = `household:${JSON.stringify([...ids].sort())}`;
      while (positions.has(id)) id = "_" + id;
      const xs = ids.map((id) => positions.get(id)!.x);
      return {
        id,
        members: ids,
        x: Math.min(...xs) - 8,
        y: positions.get(ids[0])!.y - 8,
        width: Math.max(...xs) - Math.min(...xs) + width + 16,
        height: height + 16,
      };
    });
}
