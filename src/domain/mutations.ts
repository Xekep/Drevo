import { validateFamily } from "./validation.ts";
import { dateYear } from "./dates.ts";
import type { Family, Person, ExtraLinkType } from "./types.ts";
export type ConnectionType = "parent" | "spouse" | ExtraLinkType;
export type Connection = {
  from: string;
  to: string;
  type: ConnectionType;
  id?: string;
};
export const CONNECTION_NAMES: Record<ConnectionType, string> = {
  parent: "Кровный родитель",
  spouse: "Супруг / супруга",
  adoptive_parent: "Приёмный родитель",
  godparent: "Крёстный родитель",
  nurse: "Кормилица",
  sworn_sibling: "Названые брат / сестра",
  guardian: "Опекун",
};
export function connectPeople(
  family: Family,
  from: string,
  to: string,
  type: ConnectionType,
  note = "",
): Family {
  if (from === to) throw new Error("Выберите двух разных людей");
  const next = structuredClone(family),
    a = next.people.find((p) => p.id === from),
    b = next.people.find((p) => p.id === to);
  if (!a || !b) throw new Error("Человек не найден");
  if (type === "parent") {
    if (b.parents.includes(from)) throw new Error("Этот родитель уже указан");
    if (b.parents.length >= 2)
      throw new Error(
        "Уже указаны два кровных родителя. Для усыновления выберите приёмного родителя.",
      );
    b.parents.push(from);
    b.generation = Math.max(b.generation, a.generation + 1);
  } else if (type === "spouse") {
    if (a.spouses.includes(to) || b.spouses.includes(from))
      throw new Error("Этот брак уже указан");
    a.spouses.push(to);
    b.spouses.push(from);
  } else {
    next.links ||= [];
    next.links.push({
      id: crypto.randomUUID(),
      from,
      to,
      type,
      ...(note ? { note } : {}),
    });
  }
  return validateFamily(next);
}
export function removeConnection(family: Family, edge: Connection): Family {
  const next = structuredClone(family);
  if (edge.type === "parent") {
    const child = next.people.find((p) => p.id === edge.to)!;
    child.parents = child.parents.filter((id) => id !== edge.from);
    child.parentageComplete = false;
  } else if (edge.type === "spouse")
    for (const p of next.people) {
      if (p.id === edge.from)
        p.spouses = p.spouses.filter((id) => id !== edge.to);
      if (p.id === edge.to)
        p.spouses = p.spouses.filter((id) => id !== edge.from);
    }
  else next.links = (next.links || []).filter((l) => l.id !== edge.id);
  return validateFamily(next);
}
export function removePerson(family: Family, id: string): Family {
  const next = structuredClone(family);
  next.people = next.people
    .filter((p) => p.id !== id)
    .map((p) => ({
      ...p,
      ...(p.parents.includes(id) ? { parentageComplete: false } : {}),
      parents: p.parents.filter((x) => x !== id),
      spouses: p.spouses.filter((x) => x !== id),
    }));
  next.links = (next.links || []).filter((l) => l.from !== id && l.to !== id);
  next.photos = (next.photos || []).map((p) => ({
    ...p,
    tags: p.tags.filter((t) => t.personId !== id),
  }));
  return validateFamily(next);
}
export function availableColumn(people: Person[], birth: string) {
  const year = dateYear(birth);
  for (let column = 0; column < 100; column++)
    if (
      !people.some(
        (p) =>
          Math.abs(p.column - column) < 0.9 &&
          (birth
            ? !!p.birth && Math.abs(dateYear(p.birth) - year) < 15
            : !p.birth),
      )
    )
      return column;
  return 100;
}
