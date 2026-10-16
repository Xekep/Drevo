import { normalizeDateInput, validDate } from "./dates.ts";

/** Civil Julian calendar, not an astronomical Julian date. No timezone involved. */
export function julianToGregorian(value: string): string {
  if (!validDate(value, "julian"))
    throw new Error("Проверьте дату по старому стилю.");
  // A month/year is a period, not a known day. Keep its precision and calendar.
  if (value.length !== 10) return value;
  const [year, month, day] = value.split("-").map(Number);
  const a = Math.floor((14 - month) / 12),
    y = year + 4800 - a,
    m = month + 12 * a - 3;
  const dayNumber =
    day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
  const result = new Date((dayNumber - 2440588) * 86400000)
    .toISOString()
    .slice(0, 10);
  if (!validDate(result))
    throw new Error(
      "Пересчитанная дата выходит за поддерживаемые годы 0001–9999.",
    );
  return result;
}

export function normalizeLifeDate(text: string, oldStyle: boolean) {
  const original = normalizeDateInput(text, oldStyle ? "julian" : "gregorian");
  return {
    date: original && oldStyle ? julianToGregorian(original) : original,
    julian: oldStyle && original ? original : undefined,
  };
}

export function validCalendarPair(date: string | undefined, julian: unknown) {
  if (julian === undefined) return true;
  if (typeof julian !== "string" || !validDate(julian, "julian")) return false;
  try {
    return julianToGregorian(julian) === date;
  } catch {
    return false;
  }
}

export const julianInputLabel = (value: string) =>
  value.split("-").reverse().join(".");
