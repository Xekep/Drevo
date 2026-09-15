import type { AwardDefinition } from "../types.ts";
import { FOREIGN_AWARDS } from "./foreign.ts";
import { RUSSIAN_DEPARTMENTAL_AWARDS, RUSSIAN_STATE_AWARDS } from "./russia.ts";
import { USSR_AWARDS } from "./ussr.ts";

export const AWARD_CATALOG: AwardDefinition[] = [
  ...USSR_AWARDS,
  ...RUSSIAN_STATE_AWARDS,
  ...RUSSIAN_DEPARTMENTAL_AWARDS,
  ...FOREIGN_AWARDS,
];

const BY_ID = new Map(AWARD_CATALOG.map((award) => [award.id, award]));

export const getAwardDefinition = (id?: string) => (id ? BY_ID.get(id) : undefined);

const ROMAN_DEGREE: Record<string, string> = { i: "1", ii: "2", iii: "3", "1": "1", "2": "2", "3": "3" };

export function normalizeAwardName(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/(\d+)\s*-?\s*лет(?:ия|ие|ию|ний|няя)?/gu, "$1 лет")
    .replace(/[«»„“”'"`]/g, "")
    .replace(/\bгг?\.?\b/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutAwardKind(value: string) {
  return normalizeAwardName(value)
    .replace(/^(?:государственная )?(?:юбилейная |памятная )?(?:медаль|орден|крест) /, "")
    .replace(/^знак отличия(?: в труде)? /, "")
    .replace(/^нагрудный знак /, "")
    .trim();
}

function extractDegree(value: string) {
  const normalized = normalizeAwardName(value);
  const numeric = normalized.match(/(?:^| )(i{1,3}|[123]) (?:степени|степень)(?: |$)/);
  if (numeric) return ROMAN_DEGREE[numeric[1]];
  if (/\bперв(?:ой|ая) степени\b/.test(normalized)) return "1";
  if (/\bвтор(?:ой|ая) степени\b/.test(normalized)) return "2";
  if (/\bтреть(?:ей|я) степени\b/.test(normalized)) return "3";
  return undefined;
}

function removeDegree(value: string) {
  return normalizeAwardName(value)
    .replace(/(?:^| )(?:i{1,3}|[123]) (?:степени|степень)(?: |$)/, " ")
    .replace(/(?:^| )(?:первой|второй|третьей) степени(?: |$)/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function activeInYear(award: AwardDefinition, year?: string) {
  if (!year || !/^\d{4}$/.test(year)) return true;
  const y = Number(year);
  if (award.establishedAt && Number(award.establishedAt.slice(0, 4)) > y) return false;
  if (award.discontinuedAt && Number(award.discontinuedAt.slice(0, 4)) < y) return false;
  return true;
}

function matchesName(award: AwardDefinition, base: string, compactBase: string) {
  return [award.name, ...(award.aliases || [])].some((candidate) => {
    const normalized = removeDegree(candidate);
    return normalized === base || withoutAwardKind(normalized) === compactBase;
  });
}

/**
 * Auto-links only an unambiguous catalogue meaning. Year is a tie-breaker, never
 * a reason to invent a match.
 */
export function resolveAwardName(name: string, year?: string) {
  const degreeId = extractDegree(name);
  const base = removeDegree(name);
  const compactBase = withoutAwardKind(base);
  if (!compactBase) return undefined;

  let matches = AWARD_CATALOG.filter((award) => matchesName(award, base, compactBase));
  if (matches.length > 1 && year) {
    const byYear = matches.filter((award) => activeInYear(award, year));
    if (byYear.length) matches = byYear;
  }
  if (matches.length !== 1) return undefined;
  const award = matches[0];
  const degree = award.degrees?.find((item) =>
    item.id === degreeId || item.aliases?.some((alias) => normalizeAwardName(name).includes(normalizeAwardName(alias))),
  );
  return { award, degreeId: degree?.id };
}

export function searchAwards(query: string) {
  const terms = normalizeAwardName(query).split(" ").filter(Boolean);
  if (!terms.length) return AWARD_CATALOG;
  return AWARD_CATALOG.filter((award) => {
    const haystack = normalizeAwardName([
      award.name,
      ...(award.aliases || []),
      ...award.tags,
      award.countryName,
      award.issuer || "",
    ].join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}
