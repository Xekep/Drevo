import type { Person } from "./types.ts";

export type AncestorFanSlot = {
  generation: number;
  index: number;
  personId: string | null;
};

function parentPair(
  person: Person,
  people: ReadonlyMap<string, Person>,
): [string | null, string | null] {
  const ids = [...new Set(person.parents)].filter((id) => people.has(id));
  const father = ids.find((id) => people.get(id)?.sex === "m") || null;
  const mother = ids.find((id) => people.get(id)?.sex === "f") || null;
  const remaining = ids.filter((id) => id !== father && id !== mother);

  return [
    father || remaining.shift() || null,
    mother || remaining.shift() || null,
  ];
}

/**
 * Возвращает фиксированные позиции предков для веерной диаграммы.
 * Пустые позиции сохраняются, поэтому неизвестный родитель не сдвигает
 * материнскую/отцовскую ветвь и пробел в исследовании остаётся виден.
 */
export function ancestorFanSlots(
  people: Person[],
  rootId: string,
  generations = 5,
): AncestorFanSlot[] {
  const index = new Map(people.map((person) => [person.id, person]));
  if (!index.has(rootId)) return [];

  const depth = Math.max(1, Math.min(8, Math.trunc(generations) || 1));
  const slots: AncestorFanSlot[] = [];
  let current: Array<string | null> = [rootId];

  for (let generation = 0; generation < depth; generation++) {
    current.forEach((personId, slotIndex) =>
      slots.push({ generation, index: slotIndex, personId }),
    );
    if (generation === depth - 1) break;

    const next: Array<string | null> = [];
    for (const personId of current) {
      const person = personId ? index.get(personId) : undefined;
      next.push(...(person ? parentPair(person, index) : [null, null]));
    }
    current = next;
  }

  return slots;
}
