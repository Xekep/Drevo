import { normalizeDateInput, validDate } from "./dates.ts";

/**
 * Russian civil calendar switched to Gregorian on 14 February 1918.
 * Partial 1918 dates keep the option when they may precede the transition.
 * Parse with Julian rules so dates like 29.02.1900 remain eligible.
 * This is a form affordance, not a global prohibition on foreign archival
 * records that explicitly use Julian dates after the Russian transition.
 */
export function canUseOldStyleDate(text: string): boolean {
  if (!text.trim()) return false;
  try {
    const date = normalizeDateInput(text, "julian");
    return date.length === 4
      ? date <= "1918"
      : date.length === 7
        ? date <= "1918-02"
        : date < "1918-02-14";
  } catch {
    return false;
  }
}

/**
 * Byzantine Anno Mundi, Russian September-year convention (from 1492).
 * This is a different YEAR ERA, not a synonym for Julian calendar.
 * A year without a month cannot be resolved to a single Common Era year.
 */
export function canUseByzantineDate(text: string): boolean {
  if (!text.trim()) return false;
  try {
    const source = normalizeDateInput(text, "julian");
    const year = Number(source.slice(0, 4));
    return year >= 7000 && year <= 7208;
  } catch {
    return false;
  }
}

export function normalizeByzantineDate(text: string) {
  const source = normalizeDateInput(text, "julian");
  if (!canUseByzantineDate(source))
    throw new Error("Укажите дату византийской эры (7000–7208 год от Сотворения мира).");
  if (source.length === 4)
    throw new Error("Укажите месяц: сентябрьский год от Сотворения мира соответствует двум годам нашей эры.");
  const year = Number(source.slice(0, 4));
  const month = Number(source.slice(5, 7));
  const ce = year - (month >= 9 ? 5509 : 5508);
  const julian = `${String(ce).padStart(4, "0")}${source.slice(4)}`;
  if (!validDate(julian, "julian"))
    throw new Error("Проверьте исходную дату по византийскому летосчислению.");
  return { date: julianToGregorian(julian), julian, byzantine: source };
}

export function validByzantinePair(
  date: string | undefined,
  julian: string | undefined,
  byzantine: unknown,
): boolean {
  if (byzantine === undefined) return true;
  if (typeof byzantine !== "string" || !julian) return false;
  try {
    const value = normalizeByzantineDate(byzantine);
    return value.date === date && value.julian === julian;
  } catch {
    return false;
  }
}

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
