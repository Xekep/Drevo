import type { Person } from "./types.ts";
/** Каноническое хранение сохраняет точность: год, месяц или день. */
export function validDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) ||
    Number(value.slice(0, 4)) < 1
  )
    return false;
  const full =
    value.length === 4
      ? value + "-01-01"
      : value.length === 7
        ? value + "-01"
        : value;
  return (
    !Number.isNaN(Date.parse(full)) &&
    new Date(full).toISOString().slice(0, 10) === full
  );
}
export function normalizeDateInput(value: string) {
  const text = value.trim();
  if (!text) return "";
  let result = text;
  const local = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
  const month = /^(\d{1,2})[./](\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
  if (local)
    result = `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
  else if (month) result = `${month[2]}-${month[1].padStart(2, "0")}`;
  else if (iso)
    result = `${iso[1]}-${iso[2].padStart(2, "0")}${iso[3] ? "-" + iso[3].padStart(2, "0") : ""}`;
  if (!validDate(result))
    throw new Error("Проверьте дату. Например: 1.5.1980, 05.1980 или 1980.");
  return result;
}
export function dateInputLabel(value: string) {
  return validDate(value) && value.length > 4
    ? value.split("-").reverse().join(".")
    : value;
}
export function dateBound(value: string, last: boolean) {
  if (value.length === 4) return `${value}-${last ? "12-31" : "01-01"}`;
  if (value.length === 7) {
    const [year, month] = value.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month - 1
    ];
    return `${value}-${last ? days : "01"}`;
  }
  return value;
}
export const dateYear = (date?: string) =>
  date ? Number(date.slice(0, 4)) : new Date().getFullYear();
export const fullName = (p: Person) =>
  [p.surname, p.name, p.patronymic]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
/** Порядок явно указан в форме: фамилия, имя, затем отчество. */
export function splitFullName(value: string) {
  const [surname = "", name = "", ...rest] = value.trim().split(/\s+/);
  return { surname, name, patronymic: rest.join(" ") };
}
export const hasRecordedDeath = (
  p: Pick<Person, "death" | "deathPlace" | "deceased">,
) => !!(p.deceased || p.death || p.deathPlace?.trim());
export const years = (p: Person) =>
  p.birth
    ? `${dateYear(p.birth)} — ${p.death ? dateYear(p.death) : hasRecordedDeath(p) ? "?" : "н. в."}`
    : p.death
      ? `† ${dateYear(p.death)}`
      : hasRecordedDeath(p)
        ? "†"
        : "";
export function matchesPerson(p: Person, query: string) {
  const normalize = (text: string) =>
    text.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
  const text = normalize(
    `${fullName(p)} ${p.maidenName || ""} ${p.birthPlace} ${p.deathPlace || ""} ${years(p)}`,
  );
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term));
}
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100,
    b = a % 10;
  return a > 10 && a < 20
    ? many
    : b === 1
      ? one
      : b >= 2 && b <= 4
        ? few
        : many;
}
export function dateLabel(value: string) {
  if (!value) return "";
  if (!validDate(value)) return value;
  if (/^\d{4}$/.test(value)) return `${value} год`;
  return new Intl.DateTimeFormat("ru-RU", {
    ...(value.length === 10 ? { day: "numeric" as const } : {}),
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(new Date(dateBound(value, false) + "T12:00:00Z"))
    .replace(" г.", "");
}
function ageInMonths(birth: string, end: string) {
  if (birth.length < 7 || end.length < 7) return null;
  const [birthYear, birthMonth, birthDay = 1] = birth.split("-").map(Number);
  const [endYear, endMonth, endDay = 1] = end.split("-").map(Number);
  let months = (endYear - birthYear) * 12 + endMonth - birthMonth;
  if (birth.length === 10 && end.length === 10 && endDay < birthDay) months--;
  return Math.max(0, months);
}
export function ageLabel(p: Person) {
  if (!p.birth || (hasRecordedDeath(p) && !p.death)) return "";
  const end = p.death || new Date().toISOString().slice(0, 10);
  const age =
    dateYear(end) -
    dateYear(p.birth) -
    (end.length > 4 && p.birth.length > 4 && end.slice(5) < p.birth.slice(5)
      ? 1
      : 0);
  if (age < 1) {
    const months = ageInMonths(p.birth, end);
    if (months === null) return "меньше года";
    if (months === 0) return "меньше месяца";
    const approximate = p.birth.length < 10 || (p.death && p.death.length < 10);
    return `${approximate ? "около " : ""}${months} ${plural(months, "месяц", "месяца", "месяцев")}`;
  }
  return `${p.birth.length < 10 || (p.death && p.death.length < 10) ? "около " : ""}${age} ${plural(age, "год", "года", "лет")}`;
}
export function safeUrl(value?: string): string | undefined {
  if (!value) return;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"))
    return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    /* Invalid URLs are omitted. */
  }
}
