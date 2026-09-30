import type { Family } from "./types.ts";

export const CALCULATION_FIELDS = [
  "name",
  "surname",
  "sex",
  "birth",
  "death",
  "birthPlace",
  "deathPlace",
  "generation",
  "parents",
  "spouses",
] as const;

/** Receives the authorized projection; never reads storage or extra person fields. */
export function calculationData(
  family: Family,
  fields: unknown,
  personIds: unknown,
) {
  if (
    !Array.isArray(fields) ||
    fields.length > CALCULATION_FIELDS.length ||
    fields.some((field) => !CALCULATION_FIELDS.includes(field))
  )
    throw new Error("Выберите поддерживаемые поля для расчёта");
  if (
    personIds !== undefined &&
    (!Array.isArray(personIds) ||
      personIds.length > 10000 ||
      personIds.some((id) => typeof id !== "string"))
  )
    throw new Error("Некорректная выборка людей");
  const requested = personIds as string[] | undefined;
  const accessible = new Set(family.people.map((person) => person.id));
  if (requested?.some((id) => !accessible.has(id)))
    throw new Error("Человек недоступен для расчёта");
  const selected = requested?.length ? new Set(requested) : accessible;
  const people = family.people.filter((person) => selected.has(person.id));
  const columns = [...new Set(fields)] as (typeof CALCULATION_FIELDS)[number][];
  return {
    scope: "authorized_selection",
    totalPeople: columns.length ? people.length : 0,
    fields: columns,
    note: "Только выбранные поля доступных карточек. Пустые значения неизвестны; даты не достраивать. Связи ведут только к людям этой выборки. Источники и документы не проверялись.",
    people: columns.length
      ? people.map((person) => ({
          id: person.id,
          ...Object.fromEntries(
            columns.map((field) => [
              field,
              field === "parents" || field === "spouses"
                ? person[field].filter((id) => selected.has(id))
                : (person[field] ?? null),
            ]),
          ),
        }))
      : [],
  };
}
