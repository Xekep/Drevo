import type { LayoutPerson } from "../src/domain/tree-layout.ts";

export const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson => ({ id, parents, spouses, birth: "" });

/** Cousin branches join through several marriages; no private genealogy data. */
export function crossBranchMarriages(seed: number): LayoutPerson[] {
  let state = seed;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const people = [person("root-a", [], ["root-b"]), person("root-b", [], ["root-a"])];
  let families = [["root-a", "root-b"]], index = 0;
  for (let level = 0; level < 3; level++) {
    const next: string[][] = [];
    for (const family of families) for (let child = 0; child < 2; child++) {
      const a = person(`child-${index}`, family, [`partner-${index}`]),
        b = person(`partner-${index}`, [], [a.id]);
      index++; people.push(a, b); next.push([a.id, b.id]);
    }
    families = next;
  }
  const leaves: LayoutPerson[] = [];
  for (const family of families) for (let child = 0; child < 2; child++) {
    const leaf = person(`leaf-${leaves.length}`, family);
    people.push(leaf); leaves.push(leaf);
  }
  for (let i = leaves.length - 1; i > 0; i--) {
    const other = Math.floor(random() * (i + 1));
    [leaves[i], leaves[other]] = [leaves[other], leaves[i]];
  }
  for (let i = 0; i < leaves.length; i += 2) {
    leaves[i].spouses.push(leaves[i + 1].id);
    leaves[i + 1].spouses.push(leaves[i].id);
    people.push(person(`last-${i}`, [leaves[i].id, leaves[i + 1].id]));
  }
  return people;
}

/** Connected descendant families with no marriages between existing branches. */
export function branchingFamily(count: number): LayoutPerson[] {
  if (!Number.isSafeInteger(count) || count < 2) throw new RangeError("At least two people are required");
  const people = [person("f-0", [], ["f-1"]), person("f-1", [], ["f-0"])];
  const families = [["f-0", "f-1"]];
  let childIndex = 0;
  for (let family = 0; people.length < count; family++) {
    for (let child = 0; child < 2 && people.length < count; child++) {
      const member = person(`child-${childIndex}`, families[family]);
      people.push(member);
      if (people.length < count) {
        const spouse = person(`partner-${childIndex}`, [], [member.id]);
        member.spouses.push(spouse.id);
        people.push(spouse);
        families.push([member.id, spouse.id]);
      }
      childIndex++;
    }
  }
  return people;
}

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
