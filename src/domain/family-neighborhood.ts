import type { Family } from "./types.ts";

type Archive = Pick<Family, "people" | "links">;
/** Индекс только записанных связей. По именам или возрасту родство не достраивается. */
export function familyNeighbors(family: Archive) {
  const people = new Map(family.people.map((p) => [p.id, p]));
  const neighbors = new Map(
    family.people.map((p) => [p.id, new Set<string>()]),
  );
  const children = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (a === b || !people.has(a) || !people.has(b)) return;
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  };
  for (const p of family.people) {
    for (const parent of p.parents) {
      connect(parent, p.id);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(p.id);
    }
    for (const spouse of p.spouses) connect(p.id, spouse);
  }
  for (const link of family.links || []) connect(link.from, link.to);
  return { people, neighbors, children };
}

function visitParentPairs(
  index: ReturnType<typeof familyNeighbors>,
  id: string,
  visible: ReadonlySet<string>,
  add: (id: string) => void,
) {
  const parents = index.people.get(id)!.parents;
  if (parents.some((parent) => visible.has(parent)))
    for (const parent of parents) add(parent);
  for (const child of index.children.get(id) || [])
    if (visible.has(child))
      for (const parent of index.people.get(child)!.parents) add(parent);
}

/** Даже у защищённого потомка свёрнутой ветви сохраняется точная пара родителей. */
export function completeVisibleParents(
  index: ReturnType<typeof familyNeighbors>,
  initial: ReadonlySet<string>,
) {
  const visible = new Set([...initial].filter((id) => index.people.has(id))),
    queue = [...visible];
  const add = (id: string) => {
    if (index.people.has(id) && !visible.has(id)) {
      visible.add(id);
      queue.push(id);
    }
  };
  for (let i = 0; i < queue.length; i++)
    visitParentPairs(index, queue[i], visible, add);
  return visible;
}

/** Ближайшая семья, раскрываемые границы и путь к выбранным для сравнения людям. */
export function familyNeighborhood(
  index: ReturnType<typeof familyNeighbors>,
  anchor: string,
  expanded: ReadonlySet<string> = new Set(),
  pinned: readonly string[] = [],
) {
  const { people, neighbors, children } = index;
  const visible = new Set<string>();
  const queue: string[] = [];
  const add = (id: string) => {
    if (!people.has(id) || visible.has(id)) return;
    visible.add(id);
    queue.push(id);
  };
  add(anchor);
  for (const id of neighbors.get(anchor) || []) add(id);
  for (const parent of people.get(anchor)?.parents || [])
    for (const sibling of children.get(parent) || []) add(sibling);

  // Окружение братьев и сестёр: их супруги и точный второй родитель.
  const core = [...visible];
  for (const id of core)
    for (const spouse of people.get(id)!.spouses) add(spouse);

  const targets = new Set(
    pinned.filter((id) => people.has(id) && !visible.has(id)),
  );
  if (targets.size && people.has(anchor)) {
    const previous = new Map<string, string | null>([[anchor, null]]),
      visit = [anchor];
    for (let i = 0; i < visit.length && targets.size; i++) {
      const id = visit[i];
      if (targets.delete(id)) {
        let node: string | null = id;
        while (node !== null) {
          add(node);
          node = previous.get(node)!;
        }
      }
      for (const next of neighbors.get(id) || [])
        if (!previous.has(next)) {
          previous.set(next, id);
          visit.push(next);
        }
    }
  }
  for (const id of pinned) add(id);

  // Раскрываются лишь доступные из текущего вида карточки. Отсоединённые
  // раскрытия не оставляют висящие фрагменты после сворачивания ветви.
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (expanded.has(id)) for (const next of neighbors.get(id) || []) add(next);
    visitParentPairs(index, id, visible, add);
  }
  const hidden = new Map<string, number>();
  for (const id of visible) {
    const count = [...neighbors.get(id)!].filter(
      (next) => !visible.has(next),
    ).length;
    if (count) hidden.set(id, count);
  }
  return { visible, hidden };
}

/** Удаление невидимых концов относится только к проекции; архив не изменяется. */
export function projectTree(family: Archive, visible: ReadonlySet<string>) {
  return {
    people: family.people
      .filter((p) => visible.has(p.id))
      .map(({ id, birth, parents, spouses }) => ({
        id,
        birth,
        parents: parents.filter((id) => visible.has(id)),
        spouses: spouses.filter((id) => visible.has(id)),
      })),
    links: (family.links || [])
      .filter((l) => visible.has(l.from) && visible.has(l.to))
      .map(({ type, from, to }) => ({ type, from, to })),
  };
}
