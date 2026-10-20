export const peopleFilterFields = [
  ["surname", "Фамилия, включая при рождении", "text"],
  ["nameContains", "ФИО содержит", "text"],
  ["sex", "Пол", "sex"],
  ["birthYearFrom", "Родился не раньше года", "year"],
  ["birthYearTo", "Родился не позже года", "year"],
  ["deathYearFrom", "Умер не раньше года", "year"],
  ["deathYearTo", "Умер не позже года", "year"],
  ["birthPlaceContains", "Место рождения содержит", "text"],
  ["deathPlaceContains", "Место смерти содержит", "text"],
  ["occupationContains", "Занятие содержит", "text"],
  ["hasBirthDate", "Указана дата рождения", "boolean"],
  ["hasDeathDate", "Указана дата смерти", "boolean"],
  ["hasPhoto", "Есть фотография", "boolean"],
  ["hasSources", "Есть источники", "boolean"],
  ["deceased", "Отмечен умершим", "boolean"],
  ["needsReview", "Требует проверки", "boolean"],
  ["relation", "Родство с человеком", "relation"],
] as const;
export type PeopleFilterRow = {
  key: string;
  field: (typeof peopleFilterFields)[number][0];
  value: string;
  personId?: string;
};
export type PeopleFilterMode = "allOf" | "anyOf" | "noneOf";
export const filterRelations = [
  ["ancestors", "Предки"],
  ["descendants", "Потомки"],
  ["parents", "Родители"],
  ["children", "Дети"],
  ["spouses", "Партнёры"],
  ["siblings", "Братья и сёстры"],
] as const;

export function buildPeopleCriteria(
  rows: PeopleFilterRow[],
  mode: PeopleFilterMode,
): Record<string, unknown> {
  if (
    !["allOf", "anyOf", "noneOf"].includes(mode) ||
    !rows.length ||
    rows.length > 10
  )
    throw new Error("Добавьте от 1 до 10 условий");
  return {
    [mode]: rows.map((row) => {
      const descriptor = peopleFilterFields.find(
        ([field]) => field === row.field,
      );
      if (!descriptor) throw new Error("Неизвестное условие");
      const [, label, type] = descriptor;
      if (type === "year") {
        if (!/^[1-9]\d{0,3}$/.test(row.value.trim()))
          throw new Error(`${label}: укажите год от 1 до 9999`);
        return { [row.field]: Number(row.value) };
      }
      if (type === "boolean") {
        if (row.value !== "true" && row.value !== "false")
          throw new Error(`${label}: выберите да или нет`);
        return { [row.field]: row.value === "true" };
      }
      if (type === "relation") {
        if (
          !row.personId ||
          !filterRelations.some(([value]) => value === row.value)
        )
          throw new Error("Выберите человека и вид родства");
        return { relation: row.value, relativeOf: row.personId };
      }
      if (type === "sex" && !["m", "f", "u"].includes(row.value))
        throw new Error("Выберите пол");
      if (!row.value.trim() || row.value.length > 200)
        throw new Error(`${label}: заполните значение, не более 200 символов`);
      return { [row.field]: row.value.trim() };
    }),
  };
}

export function peopleCriteriaRows(criteria: Record<string, unknown>): {
  mode: PeopleFilterMode;
  rows: PeopleFilterRow[];
} {
  const mode = (["allOf", "anyOf", "noneOf"] as const).find((key) =>
    Array.isArray(criteria[key]),
  );
  if (!mode || Object.keys(criteria).length !== 1)
    throw new Error("Сохранённый поиск имеет неподдерживаемый формат");
  const rows = (criteria[mode] as Record<string, unknown>[]).map(
    (condition, index) => {
      const field = peopleFilterFields.find(([key]) =>
        Object.hasOwn(condition, key),
      )?.[0];
      if (!field) throw new Error("Сохранённое условие не поддерживается");
      if (
        Object.keys(condition).some(
          (key) =>
            key !== field && !(field === "relation" && key === "relativeOf"),
        )
      )
        throw new Error(
          "Сохранённое условие содержит дополнительные ограничения",
        );
      return {
        key: String(index),
        field,
        value: String(condition[field]),
        ...(field === "relation"
          ? { personId: String(condition.relativeOf || "") }
          : {}),
      };
    },
  );
  buildPeopleCriteria(rows, mode);
  return { mode, rows };
}
