import {
  dateInputLabel,
  fullName,
  hasRecordedDeath,
  plural,
  validDate,
} from "./dates.ts";
import type { Person } from "./types.ts";

export type MemorialPerson = Pick<
  Person,
  "id" | "surname" | "name" | "patronymic" | "death" | "deathJulian"
> &
  Partial<Pick<Person, "birth" | "birthJulian" | "deceased" | "deathPlace">>;
export type MemorialDate = {
  id: string;
  personId: string;
  personName: string;
  date: string;
  years: number;
  days: number;
} & (
  | { kind: "birthday"; birth: string }
  | { kind: "death_anniversary"; death: string }
);

/** Civil dates only; incomplete Julian periods must not become Gregorian days. */
export function upcomingMemorialDates(
  people: MemorialPerson[],
  today: string,
): MemorialDate[] {
  if (!validDate(today) || today.length !== 10)
    throw new Error("Некорректная текущая дата");
  const start = Date.parse(`${today}T00:00:00Z`);
  const upcomingDays = Array.from({ length: 8 }, (_, days) => {
    const date = new Date(start + days * 86400000).toISOString().slice(0, 10);
    return { days, date, year: Number(date.slice(0, 4)) };
  });
  const result: MemorialDate[] = [];
  for (const person of people) {
    const birthday = !hasRecordedDeath(person);
    const eventDate = birthday ? person.birth : person.death;
    const julian = birthday ? person.birthJulian : person.deathJulian;
    if (
      !validDate(eventDate) ||
      eventDate.length !== 10 ||
      (julian && julian.length !== 10)
    )
      continue;
    for (const { days, date, year } of upcomingDays) {
      const monthDay = eventDate.slice(5);
      // February 29 is commemorated on February 28 in a common year.
      const observed =
        monthDay === "02-29" && !validDate(`${year}-02-29`)
          ? "02-28"
          : monthDay;
      const years = year - Number(eventDate.slice(0, 4));
      // Suppress historical cards with missing death details. This is a
      // reminder filter, never an inferred death or a change to the person.
      if (years < 1 || (birthday && years > 120) || date.slice(5) !== observed)
        continue;
      result.push({
        id: `${person.id}:${birthday ? "birthday:" : ""}${eventDate}:${date}`,
        personId: person.id,
        personName: fullName(person) || "Имя неизвестно",
        date,
        ...(birthday
          ? { kind: "birthday" as const, birth: eventDate }
          : { kind: "death_anniversary" as const, death: eventDate }),
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
  if (item.kind === "birthday")
    return `${item.days === 0 ? "Сегодня" : dateInputLabel(item.date)} — день рождения, ${item.days === 0 ? "исполнилось" : "исполнится"} ${item.years} ${plural(item.years, "год", "года", "лет")}`;
  return `${item.days === 0 ? "Сегодня" : dateInputLabel(item.date)} — ${item.years} ${plural(item.years, "год", "года", "лет")} со дня смерти`;
}
