import type { LayoutPerson } from "./tree-layout.ts";

/** Поколения семейных союзов, а не глубина отдельно взятого человека. */
export function householdLevels(people: LayoutPerson[]) {
  const owners = new Map(people.map((p) => [p.id, p.id]));
  const find = (id: string): string => {
    let root = id;
    while (owners.get(root) !== root) root = owners.get(root)!;
    while (owners.get(id) !== id) {
      const next = owners.get(id)!;
      owners.set(id, root);
      id = next;
    }
    return root;
  };
  const join = (a: string, b: string) => {
    if (owners.has(a) && owners.has(b)) owners.set(find(b), find(a));
  };
  for (const p of people) {
    for (const spouse of p.spouses) join(p.id, spouse);
    for (const other of p.parents.slice(1)) join(p.parents[0], other);
  }
  const groups = new Map(people.map((p) => [p.id, find(p.id)]));
  function rank() {
    const nodes = new Set(groups.values()),
      children = new Map([...nodes].map((id) => [id, new Set<string>()])),
      incoming = new Map([...nodes].map((id) => [id, 0]));
    for (const p of people)
      for (const parent of p.parents) {
        const from = groups.get(parent),
          to = groups.get(p.id)!;
        if (from !== undefined && !children.get(from)!.has(to)) {
          children.get(from)!.add(to);
          incoming.set(to, incoming.get(to)! + 1);
        }
      }
    const queue = [...nodes].filter((id) => !incoming.get(id)),
      levels = new Map(queue.map((id) => [id, 0])),
      processed = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      processed.add(id);
      for (const child of children.get(id)!) {
        levels.set(
          child,
          Math.max(levels.get(child) || 0, levels.get(id)! + 1),
        );
        incoming.set(child, incoming.get(child)! - 1);
        if (!incoming.get(child)) queue.push(child);
      }
    }
    return {
      levels,
      unresolved: new Set([...nodes].filter((id) => !processed.has(id))),
    };
  }
  let result = rank();
  if (result.unresolved.size) {
    // Союз родственников разных поколений может замкнуть сжатый граф.
    // Раскрываем только затронутые группы; реальные связи не удаляются.
    for (const [id, group] of groups)
      if (result.unresolved.has(group)) groups.set(id, id);
    result = rank();
  }
  return new Map(
    people.map((p) => [p.id, result.levels.get(groups.get(p.id)!) || 0]),
  );
}
