import type { Person } from "./types.ts";
export const dateYear = (date?: string) =>
  date ? Number(date.slice(0, 4)) : new Date().getFullYear();
export const fullName = (p: Person) =>
  `${p.surname} ${p.name} ${p.patronymic}`.trim();
export const initials = (p: Person) =>
  `${p.name.trim()[0] || ""}${p.surname.trim()[0] || ""}` || "?";
export const years = (p: Person) =>
  `${dateYear(p.birth)} — ${p.death ? dateYear(p.death) : "н. в."}`;
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
  if (/^\d{4}$/.test(value)) return `${value} год`;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(new Date(value + "T12:00:00Z"))
    .replace(" г.", "");
}
export function ageLabel(p: Person) {
  const end = p.death || new Date().toISOString().slice(0, 10);
  const age =
    dateYear(end) -
    dateYear(p.birth) -
    (end.length > 4 && p.birth.length > 4 && end.slice(5) < p.birth.slice(5)
      ? 1
      : 0);
  return `${p.birth.length === 4 || p.death?.length === 4 ? "около " : ""}${age} ${plural(age, "год", "года", "лет")}`;
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
