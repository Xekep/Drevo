import { dateBound, hasRecordedDeath, validDate } from "./dates.ts";
import type { Family, Person } from "./types.ts";

export const PEOPLE_FILTER_SCHEMA = {
  type: "object",
  properties: {
    deceased: {
      type: "boolean",
      description:
        "Записан факт смерти; отсутствие даты смерти само по себе не означает, что человек жив.",
    },
    needsReview: { type: "boolean" },
    sex: { type: "string", enum: ["m", "f", "u"] },
    birthYearFrom: { type: "integer", minimum: 1, maximum: 9999 },
    birthYearTo: { type: "integer", minimum: 1, maximum: 9999 },
    deathAgeFrom: {
      type: "integer",
      minimum: 0,
      maximum: 150,
      description: "Возраст смерти не меньше указанного, включительно.",
    },
    deathAgeBefore: {
      type: "integer",
      minimum: 1,
      maximum: 151,
      description:
        "Возраст смерти строго меньше указанного. Для умерших до 18 лет: 18. Неизвестные и пограничные неточные даты не совпадают.",
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

type Criteria = {
  deceased?: boolean;
  needsReview?: boolean;
  sex?: "m" | "f" | "u";
  birthYearFrom?: number;
  birthYearTo?: number;
  deathAgeFrom?: number;
  deathAgeBefore?: number;
};

/** Match only facts certain enough to satisfy every condition. */
function matches(person: Person, criteria: Criteria) {
  if (
    criteria.deceased !== undefined &&
    hasRecordedDeath(person) !== criteria.deceased
  )
    return false;
  if (
    criteria.needsReview !== undefined &&
    !!person.needsReview !== criteria.needsReview
  )
    return false;
  if (criteria.sex !== undefined && person.sex !== criteria.sex) return false;
  if (
    criteria.birthYearFrom !== undefined ||
    criteria.birthYearTo !== undefined
  ) {
    if (!validDate(person.birth)) return false;
    const year = Number(person.birth.slice(0, 4));
    if (criteria.birthYearFrom !== undefined && year < criteria.birthYearFrom)
      return false;
    if (criteria.birthYearTo !== undefined && year > criteria.birthYearTo)
      return false;
  }
  if (
    criteria.deathAgeFrom !== undefined ||
    criteria.deathAgeBefore !== undefined
  ) {
    if (
      !validDate(person.birth) ||
      !validDate(person.death) ||
      dateBound(person.death, true) < dateBound(person.birth, false)
    )
      return false;
    const years = (birth: string, death: string) =>
      Number(death.slice(0, 4)) -
      Number(birth.slice(0, 4)) -
      Number(death.slice(5) < birth.slice(5));
    const minimum = Math.max(
      0,
      years(dateBound(person.birth, true), dateBound(person.death, false)),
    );
    const maximum = years(
      dateBound(person.birth, false),
      dateBound(person.death, true),
    );
    if (criteria.deathAgeFrom !== undefined && minimum < criteria.deathAgeFrom)
      return false;
    if (
      criteria.deathAgeBefore !== undefined &&
      maximum >= criteria.deathAgeBefore
    )
      return false;
  }
  return true;
}

export function filterResearchPeople(
  family: Family,
  value: unknown,
  mode: unknown,
) {
  if (mode !== "include" && mode !== "exclude")
    throw new Error("Выберите включение или исключение по условию");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Укажите условия отбора людей");
  const entries = Object.entries(value);
  if (!entries.length) throw new Error("Укажите хотя бы одно условие отбора");
  for (const [key, item] of entries) {
    if (!Object.hasOwn(PEOPLE_FILTER_SCHEMA.properties, key))
      throw new Error("Неизвестное условие отбора");
    if (key === "deceased" || key === "needsReview") {
      if (typeof item !== "boolean")
        throw new Error("Условие должно быть логическим значением");
    } else if (key === "sex") {
      if (typeof item !== "string" || !["m", "f", "u"].includes(item))
        throw new Error("Неизвестное значение пола");
    } else {
      const schema =
        PEOPLE_FILTER_SCHEMA.properties[
          key as
            "birthYearFrom" | "birthYearTo" | "deathAgeFrom" | "deathAgeBefore"
        ];
      if (
        typeof item !== "number" ||
        !Number.isInteger(item) ||
        item < schema.minimum ||
        item > schema.maximum
      )
        throw new Error("Проверьте числовые границы отбора");
    }
  }
  const criteria = value as Criteria;
  if (
    criteria.birthYearFrom !== undefined &&
    criteria.birthYearTo !== undefined &&
    criteria.birthYearFrom > criteria.birthYearTo
  )
    throw new Error("Начальный год не может быть больше конечного");
  if (
    criteria.deathAgeFrom !== undefined &&
    criteria.deathAgeBefore !== undefined &&
    criteria.deathAgeFrom >= criteria.deathAgeBefore
  )
    throw new Error("Возрастной диапазон пуст");
  const matched = new Set(
    family.people
      .filter((person) => matches(person, criteria))
      .map((person) => person.id),
  );
  return {
    personIds: family.people
      .filter((person) =>
        mode === "include" ? matched.has(person.id) : !matched.has(person.id),
      )
      .map((person) => person.id),
    matchedCount: matched.size,
    totalPeople: family.people.length,
  };
}
