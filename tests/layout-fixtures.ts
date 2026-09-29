import type { LayoutPerson } from "../src/domain/tree-layout.ts";

export const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson => ({ id, parents, spouses, birth: "" });

/** Одна и та же семейная структура для замеров раскладки и её регрессий. */
export function randomFamily(seed: number, generations = 2): LayoutPerson[] {
  let state = seed;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const shuffle = (items: string[]) => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  const people = Array.from({ length: 12 }, (_, index) => person(`f-${index}`));
  const map = new Map(people.map((entry) => [entry.id, entry]));
  const generation = (parents: string[], prefix: string) => {
    const children: string[] = [];
    const shuffled = shuffle(parents);
    for (let index = 0; index + 1 < shuffled.length; index += 2) {
      const left = shuffled[index];
      const right = shuffled[index + 1];
      map.get(left)!.spouses.push(right);
      map.get(right)!.spouses.push(left);
      const count = 2 + Math.floor(random() * 3);
      for (let child = 0; child < count; child++) {
        const entry = person(`${prefix}-${index / 2}-${child}`, [left, right]);
        people.push(entry);
        map.set(entry.id, entry);
        children.push(entry.id);
      }
    }
    return children;
  };
  let parents = people.map((entry) => entry.id);
  for (let level = 0; level < generations; level++)
    parents = generation(parents, ["c", "g", "h"][level] || `level-${level}`);
  return people;
}

export function editedFamily(original: LayoutPerson[], index: number) {
  const edited = structuredClone(original);
  const child = edited.find((entry) => entry.id.startsWith("g-"))!;
  const spouse = person(`new-spouse-${index}`, [], [child.id]);
  child.spouses.push(spouse.id);
  edited.push(spouse);
  for (let offset = 0; offset < 2; offset++)
    edited.push(person(`new-child-${index}-${offset}`, [child.id, spouse.id]));
  return edited;
}

export function editedAncestorFamily(original: LayoutPerson[], index: number) {
  const edited = structuredClone(original);
  const founder = edited.find((entry) => entry.id === "f-0")!;
  const ancestor = person(`ancestor-${index}`);
  founder.parents.push(ancestor.id);
  edited.push(ancestor);
  return edited;
}
