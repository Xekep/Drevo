import type { LayoutPerson } from "./tree-layout.ts";
import { untangleFamilies } from "./layout-order.ts";

/** Семейные блоки: родители рядом, потомки по центру своей ветви. Только геометрия. */
export function familyPositions(
  people: LayoutPerson[],
  levels: Map<string, number>,
  width: number,
  height: number,
) {
  const map = new Map(people.map((p) => [p.id, p]));
  const groups = new Map(people.map((p) => [p.id, p.id]));
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
    if (map.has(a) && map.has(b) && levels.get(a) === levels.get(b))
      groups.set(find(b), find(a));
  };
  for (const p of people) {
    for (const spouse of p.spouses) join(p.id, spouse);
    for (const parent of p.parents.slice(1)) join(p.parents[0], parent);
  }
  type Unit = {
    id: string;
    members: LayoutPerson[];
    level: number;
    children: Unit[];
    parent?: Unit;
    width: number;
    depth: number;
    x: number;
    y: number;
  };
  const units = new Map<string, Unit>();
  for (const p of people) {
    const id = find(p.id);
    if (!units.has(id))
      units.set(id, {
        id,
        members: [],
        level: levels.get(p.id) || 0,
        children: [],
        width: 0,
        depth: 0,
        x: 0,
        y: 0,
      });
    units.get(id)!.members.push(p);
  }
  for (const unit of units.values()) {
    const parents = [
      ...new Set(
        unit.members.flatMap((p) =>
          p.parents.filter((id) => map.has(id)).map(find),
        ),
      ),
    ]
      .map((id) => units.get(id)!)
      .filter((p) => p !== unit && p.level < unit.level);
    // Повторные браки и схождение ветвей: для размещения выбираем одну опору,
    // все настоящие связи по-прежнему рисует адаптер графа.
    unit.parent = parents.sort(
      (a, b) => b.level - a.level || a.id.localeCompare(b.id),
    )[0];
    unit.parent?.children.push(unit);
    unit.members.sort(
      (a, b) =>
        (a.birth || "9999").localeCompare(b.birth || "9999") ||
        a.id.localeCompare(b.id),
    );
  }
  const ordered = [...units.values()].sort((a, b) => b.level - a.level);
  const memberWidth = (unit: Unit) =>
    unit.members.length * width + (unit.members.length - 1) * 32;
  for (const unit of ordered) {
    unit.children.sort(
      (a, b) =>
        (a.members[0].birth || "9999").localeCompare(
          b.members[0].birth || "9999",
        ) || a.id.localeCompare(b.id),
    );
    unit.width = Math.max(
      memberWidth(unit),
      unit.children.reduce((sum, child) => sum + child.width, 0) +
        Math.max(0, unit.children.length - 1) * 64,
    );
    unit.depth = Math.max(
      unit.level,
      ...unit.children.map((child) => child.depth),
    );
  }
  let shelfX = 0,
    shelfY = 0,
    shelfHeight = 0;
  const queue: Unit[] = [];
  const roots = ordered
    .filter((u) => !u.parent)
    .sort((a, b) => a.id.localeCompare(b.id));
  const rootOf = new Map<string, Unit>();
  for (const unit of [...ordered].reverse())
    rootOf.set(unit.id, unit.parent ? rootOf.get(unit.parent.id)! : unit);
  const neighbors = new Map(roots.map((root) => [root.id, new Set<Unit>()]));
  for (const p of people)
    for (const id of [...p.parents, ...p.spouses]) {
      if (!map.has(id)) continue;
      const a = rootOf.get(find(p.id))!,
        b = rootOf.get(find(id))!;
      if (a !== b) {
        neighbors.get(a.id)!.add(b);
        neighbors.get(b.id)!.add(a);
      }
    }
  const seen = new Set<string>();
  for (const first of roots) {
    if (seen.has(first.id)) continue;
    const component = [first];
    seen.add(first.id);
    for (let i = 0; i < component.length; i++)
      for (const next of neighbors.get(component[i].id)!)
        if (!seen.has(next.id)) {
          seen.add(next.id);
          component.push(next);
        }
    const componentWidth =
      component.reduce((sum, root) => sum + root.width, 0) +
      (component.length - 1) * 100;
    const firstLevel = Math.min(...component.map((root) => root.level));
    if (shelfX && shelfX + componentWidth > 1600) {
      shelfX = 0;
      shelfY += shelfHeight + 110;
      shelfHeight = 0;
    }
    for (const root of component) {
      root.x = shelfX;
      root.y = shelfY + (root.level - firstLevel) * 190;
      shelfX += root.width + 100;
      shelfHeight = Math.max(
        shelfHeight,
        (root.depth - firstLevel) * 190 + height,
      );
      queue.push(root);
    }
  }
  const positions: [string, { x: number; y: number }][] = [];
  for (let i = 0; i < queue.length; i++) {
    const unit = queue[i],
      center = unit.x + unit.width / 2;
    unit.members.forEach((p, index) =>
      positions.push([
        p.id,
        { x: center - memberWidth(unit) / 2 + index * (width + 32), y: unit.y },
      ]),
    );
    const total =
      unit.children.reduce((sum, child) => sum + child.width, 0) +
      Math.max(0, unit.children.length - 1) * 64;
    let x = center - total / 2;
    for (const child of unit.children) {
      child.x = x;
      child.y = unit.y + (child.level - unit.level) * 190;
      x += child.width + 64;
      queue.push(child);
    }
  }
  return untangleFamilies(
    people,
    positions,
    [...units.values()].map((unit) => unit.members.map((p) => p.id)),
    width,
  );
}
