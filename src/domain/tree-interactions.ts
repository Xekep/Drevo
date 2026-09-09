import type { Person } from "./types.ts";
export function relativeAtHandle(
  handle: string | null | undefined,
  reverse: boolean,
): "parent" | "child" | "spouse" {
  if (handle === "left" || handle === "right") return "spouse";
  return (handle === "top") !== reverse ? "parent" : "child";
}
export function initialFamilyFocus(people: Person[]) {
  const children = new Map<string, string[]>();
  for (const p of people)
    for (const id of p.parents) {
      const list = children.get(id) || [];
      list.push(p.id);
      children.set(id, list);
    }
  const anchor = [...people].sort(
    (a, b) =>
      (children.get(b.id)?.length || 0) +
        b.parents.length +
        b.spouses.length -
        (children.get(a.id)?.length || 0) -
        a.parents.length -
        a.spouses.length || a.id.localeCompare(b.id),
  )[0];
  return anchor
    ? [
        ...new Set([
          anchor.id,
          ...anchor.parents,
          ...anchor.spouses,
          ...(children.get(anchor.id) || []),
        ]),
      ]
    : [];
}
