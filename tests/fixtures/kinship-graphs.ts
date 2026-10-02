import type {
  FamilyLink,
  FamilyUnion,
  Person,
} from "../../src/domain/types.ts";

export const kinshipPerson = (
  id: string,
  parents: string[] = [],
  sex: Person["sex"] = "u",
): Person => ({
  id,
  surname: "Тестов",
  name: id,
  patronymic: "",
  sex,
  birth: "",
  birthPlace: "",
  parents,
  spouses: [],
  generation: 0,
  column: 0,
  sources: [],
});

/** Зафиксированные графы для oracle: циклы, collapse, неполные родители, направленные и дополнительные связи. */
export function kinshipGraphs() {
  const types: FamilyLink["type"][] = [
    "adoptive_parent",
    "foster_parent",
    "presumed_parent",
    "step_parent",
    "godparent",
    "nurse",
    "sworn_sibling",
    "twin",
    "guardian",
  ];
  return Array.from({ length: 24 }, (_, seed) => {
    let state = seed + 1;
    const next = (max: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % max;
    };
    const people = Array.from({ length: 12 }, (_, i) =>
      kinshipPerson(`p${i}`, [], (["u", "f", "m"] as const)[next(3)]),
    );
    for (const person of people) {
      person.name = ["Иван", "Анна", "Неизвестный", "Алексей"][next(4)];
      person.patronymic = ["", "Иванович", "Ивановна"][next(3)];
      person.parents = Array.from({ length: next(3) }, () => `p${next(14)}`);
      person.spouses = Array.from({ length: next(3) }, () => `p${next(12)}`);
      person.parentageComplete = [undefined, true, false][next(3)];
    }
    const links: FamilyLink[] = Array.from({ length: 18 }, (_, i) => ({
      id: `l${i}`,
      from: `p${next(12)}`,
      to: `p${next(12)}`,
      type: types[(i + seed) % types.length],
      note: i % 4 === 0 ? `Запись ${i}` : undefined,
      twinKind: (["identical", "fraternal", "unknown"] as const)[next(3)],
    }));
    const unions: FamilyUnion[] = people.flatMap((person, i) =>
      person.spouses.map((spouse) => ({
        id: `u${i}-${spouse}`,
        participants: [person.id, spouse] as [string, string],
        type: "marriage" as const,
        ...(i % 3 === 0
          ? { ending: {} }
          : i % 3 === 1
            ? { divorce: { date: "1980" } }
            : { formation: { date: "2999" } }),
      })),
    );
    // Перестановка архивного порядка меняет разрешение равных путей и должна сохраниться.
    if (seed % 2) people.reverse();
    return { people, links, unions };
  });
}
