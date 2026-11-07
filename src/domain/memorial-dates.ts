import { dateInputLabel, fullName, plural, validDate } from "./dates.ts";
import type { Person } from "./types.ts";

export type MemorialPerson = Pick<
  Person,
  "id" | "surname" | "name" | "patronymic" | "death" | "deathJulian"
>;
export type MemorialDate = {
  id: string;
  personId: string;
  personName: string;
  date: string;
  death: string;
  years: number;
  days: number;
};

/** Civil dates only; incomplete Julian periods must not become Gregorian days. */
export function upcomingMemorialDates(
  people: MemorialPerson[],
  today: string,
): MemorialDate[] {
  if (!validDate(today) || today.length !== 10)
    throw new Error("Некорректная текущая дата");
  const start = Date.parse(`${today}T00:00:00Z`);
  const result: MemorialDate[] = [];
  for (const person of people) {
    if (
      !validDate(person.death) ||
      person.death.length !== 10 ||
      (person.deathJulian && person.deathJulian.length !== 10)
    )
      continue;
    for (let days = 0; days <= 7; days++) {
      const date = new Date(start + days * 86400000).toISOString().slice(0, 10);
      const year = Number(date.slice(0, 4));
      const monthDay = person.death.slice(5);
      // February 29 is commemorated on February 28 in a common year.
      const observed =
        monthDay === "02-29" && !validDate(`${year}-02-29`)
          ? "02-28"
          : monthDay;
      const years = year - Number(person.death.slice(0, 4));
      if (years < 1 || date.slice(5) !== observed) continue;
      result.push({
        id: `${person.id}:${person.death}:${date}`,
        personId: person.id,
        personName: fullName(person) || "Имя неизвестно",
        date,
        death: person.death,
        years,
        days,
      });
    }
  }
  return result.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.personName.localeCompare(b.personName, "ru") ||
      a.personId.localeCompare(b.personId),
  );
}

export function memorialDateLabel(item: MemorialDate) {
  return `${item.days === 0 ? "Сегодня" : dateInputLabel(item.date)} — ${item.years} ${plural(item.years, "год", "года", "лет")} со дня смерти`;
}
