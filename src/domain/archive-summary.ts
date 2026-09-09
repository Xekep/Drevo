import { validDate, plural } from "./dates.ts";
import type { Person } from "./types.ts";

/** Самая длинная подтверждённая цепочка родителей; браки не добавляют поколения. */
export function archiveSummary(
  people: Pick<Person, "id" | "parents" | "birth" | "death">[],
) {
  const known = new Set(people.map((p) => p.id));
  const remaining = new Map<string, number>(),
    children = new Map<string, string[]>(),
    depth = new Map<string, number>();
  const queue: string[] = [];
  let first: number | undefined,
    last: number | undefined,
    generations = 0;
  for (const p of people) {
    const parents = [...new Set(p.parents.filter((id) => known.has(id)))];
    remaining.set(p.id, parents.length);
    depth.set(p.id, 1);
    if (!parents.length) queue.push(p.id);
    for (const id of parents) {
      const list = children.get(id) || [];
      list.push(p.id);
      children.set(id, list);
    }
    for (const date of [p.birth, p.death])
      if (validDate(date)) {
        const year = Number(date.slice(0, 4));
        first = Math.min(first ?? year, year);
        last = Math.max(last ?? year, year);
      }
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i],
      level = depth.get(id)!;
    generations = Math.max(generations, level);
    for (const child of children.get(id) || []) {
      depth.set(child, Math.max(depth.get(child)!, level + 1));
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) queue.push(child);
    }
  }
  return {
    people: people.length,
    generations: queue.length === people.length ? generations : null,
    first,
    last,
    span: first !== undefined && last !== undefined ? last - first : undefined,
  };
}

export function counted(value: number, words: [string, string, string]) {
  return `${value} ${plural(value, ...words)}`;
}
