import type { FamilyLink, Person } from "./types.ts";
import { resolvedSex } from "./name-hints.ts";

type Ancestor = { distance: number; previous?: string };
export type Ancestors = Map<string, Ancestor>;

/** Пути хранят только предшественника: длинная родословная не копируется на каждом шаге. */
export function ancestorPath(paths: Ancestors, id: string): string[] {
  const path = [id];
  while (paths.get(id)?.previous !== undefined) {
    id = paths.get(id)!.previous!;
    path.push(id);
  }
  return path.reverse();
}

export function prepareKinshipGraph(input: Person[], inputLinks: FamilyLink[]) {
  const people = input.map((person) => ({
    ...person,
    sex: resolvedSex(person),
    parents: [...person.parents],
    spouses: [...person.spouses],
  }));
  const links = inputLinks.map((link) => ({ ...link }));
  const map = new Map(people.map((person) => [person.id, person]));
  // Legacy find выбирает первую запись, Map — последнюю. Не меняем это при повреждённых id.
  const first = new Map<string, Person>();
  const incoming = new Map<string, string[]>();
  for (const person of people) {
    if (!first.has(person.id)) first.set(person.id, person);
    // Совмещённый список в порядке people, а не отдельные children и spouses.
    for (const id of new Set([...person.parents, ...person.spouses])) {
      const values = incoming.get(id) || [];
      values.push(person.id);
      incoming.set(id, values);
    }
  }
  const touching = new Map<string, FamilyLink[]>();
  const godChildren = new Map<string, string[]>();
  const nurses = new Map<string, string[]>();
  const stepParents = new Map<
    string,
    Array<{ link: FamilyLink; order: number }>
  >();
  const append = <T>(index: Map<string, T[]>, id: string, value: T) => {
    const values = index.get(id) || [];
    values.push(value);
    index.set(id, values);
  };
  links.forEach((link, order) => {
    for (const id of new Set([link.from, link.to])) append(touching, id, link);
    if (link.type === "godparent") append(godChildren, link.from, link.to);
    if (link.type === "nurse") append(nurses, link.to, link.from);
    if (link.type === "step_parent")
      append(stepParents, link.to, { link, order });
  });
  const neighbors = (id: string, extra = false) => {
    const person = map.get(id)!;
    return new Set([
      ...person.parents,
      ...person.spouses,
      ...(incoming.get(id) || []),
      ...(extra
        ? (touching.get(id) || [])
            .filter((link) => link.type !== "presumed_parent")
            .map((link) => (link.from === id ? link.to : link.from))
        : []),
    ]);
  };
  const cachedAncestors = new Map<string, Ancestors>();
  const budget = Math.max(32768, people.length);
  let cachedEntries = 0;
  const ancestors = (id: string) => {
    const cached = cachedAncestors.get(id);
    if (cached) {
      cachedAncestors.delete(id);
      cachedAncestors.set(id, cached);
      return cached;
    }
    const paths: Ancestors = new Map([[id, { distance: 0 }]]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const child = queue[i];
      for (const parent of map.get(child)?.parents || []) {
        if (!paths.has(parent) && map.has(parent)) {
          paths.set(parent, {
            distance: paths.get(child)!.distance + 1,
            previous: child,
          });
          queue.push(parent);
        }
      }
    }
    while (
      cachedAncestors.size &&
      (cachedAncestors.size >= 16 || cachedEntries + paths.size > budget)
    ) {
      const oldest = cachedAncestors.keys().next().value!;
      cachedEntries -= cachedAncestors.get(oldest)!.size;
      cachedAncestors.delete(oldest);
    }
    cachedAncestors.set(id, paths);
    cachedEntries += paths.size;
    return paths;
  };
  return {
    map,
    first,
    touching,
    godChildren,
    nurses,
    stepParents,
    neighbors,
    ancestors,
  };
}

export type KinshipGraph = ReturnType<typeof prepareKinshipGraph>;
