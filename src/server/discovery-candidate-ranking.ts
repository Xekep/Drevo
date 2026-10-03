export type PublishedCandidate = {
  name: string; birthSurname?: string; birthYear?: string; deathYear?: string;
  birthPlace?: string; deathPlace?: string;
  surname?: string; givenName?: string;
};

const words = (value: string): string[] =>
  value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) || [];
function nameParts(person: PublishedCandidate) {
  // The projection carries the boundary for multiword surnames. For older
  // published rows not yet backfilled, preserve punctuation within the first
  // surname token instead of mistaking a hyphenated part for the given name.
  const [surname = "", given = ""] = person.name.trim().split(/\s+/);
  const currentSurnames = words(person.surname ?? surname);
  const birthSurnames = words(person.birthSurname || "");
  return { given: words(person.givenName ?? given)[0] || "", currentSurnames,
    birthSurnames, surnames: [...currentSurnames, ...birthSurnames] };
}
export function candidateNameQuery(person: PublishedCandidate): string | null {
  const { given, surnames } = nameParts(person);
  const terms = [...new Set(surnames.filter((value) => value.length >= 2))].slice(0, 4);
  return given.length >= 2 && terms.length ? `${given} & (${terms.join(" | ")})` : null;
}
export function candidateFuzzyTerms(person: PublishedCandidate) {
  const { given, surnames } = nameParts(person);
  const terms = [...new Set(surnames.filter((value) => value.length >= 4))].slice(0, 2);
  return given.length >= 4 && terms.length ? { given, surnames: terms } : null;
}
export function candidatePlaceQueries(person: PublishedCandidate) {
  const given = nameParts(person).given;
  const year = person.birthYear;
  // The changed-surname evidence requires a close birth year even when the
  // shared settlement is a death place. Probe both opt-in places separately.
  if (given.length < 2 || !year || !/^\d{4}$/.test(year)) return [];
  const terms = [...new Set([person.birthPlace,person.deathPlace]
    .map((place) => localityWords(place || "").filter((word) => word.length >= 4))
    .filter((locality) => locality.length)
    .map((locality) => `${given} & ${locality.join(" & ")}`))];
  return terms.map((query) => ({ terms: query,
    from: String(Math.max(1, Number(year) - 2)).padStart(4, "0"),
    to: String(Math.min(9999, Number(year) + 2)).padStart(4, "0") }));
}
function editDistance(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let index = 1; index <= left.length; index++) {
    const current = [index];
    for (let other = 1; other <= right.length; other++)
      current[other] = Math.min(current[other - 1] + 1, previous[other] + 1,
        previous[other - 1] + (left[index - 1] === right[other - 1] ? 0 : 1));
    if (Math.min(...current) > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
}
function similar(left: string, right: string) {
  if (left === right) return true;
  const minimum = Math.min(left.length, right.length);
  return minimum >= 4 && editDistance(left, right, minimum >= 7 ? 2 : 1) <= (minimum >= 7 ? 2 : 1);
}
const placePrefixes = new Set(["г", "город", "с", "село", "д", "деревня", "п", "поселок", "поселение", "станица", "хутор"]);
const regions = new Set(["область", "обл", "край", "район", "республика", "губерния", "уезд", "округ", "волость", "провинция"]);
const countries = new Set(["россия", "рф", "ссср", "империя", "пруссия", "польша", "казахстан", "украина"]);
/** Use a settlement, never a country or administrative region, as place evidence. */
function localityWords(value: string) {
  const segments = value.split(/[,;]+/).map((segment) => words(segment));
  const eligible = segments.filter((segment) => segment.length &&
    !segment.some((word) => regions.has(word) || countries.has(word)));
  const settlement = eligible.filter((segment) => placePrefixes.has(segment[0] || "")).at(-1)
    || eligible.at(-1);
  return settlement?.filter((word) => !placePrefixes.has(word)) || [];
}
export function candidateEvidence(
  source: PublishedCandidate, candidate: PublishedCandidate,
) {
  const a = nameParts(source), b = nameParts(candidate);
  const givenMatches = Boolean(a.given && b.given && similar(a.given, b.given));
  const surnameMatches = a.surnames.some((left) => b.surnames.some((right) => similar(left,right)));
  const birthDifference = source.birthYear && candidate.birthYear
    ? Math.abs(Number(source.birthYear) - Number(candidate.birthYear)) : null;
  const placeOverlap = (["birthPlace","deathPlace"] as const).some((field) => {
    const left = localityWords(source[field] || ""), right = localityWords(candidate[field] || "");
    return left.some((word) => right.includes(word));
  });
  // A shared relative name alone is insufficient evidence of personal identity.
  if (!(givenMatches && surnameMatches) &&
      !(givenMatches && birthDifference !== null && birthDifference <= 2 && placeOverlap))
    return null;
  const reasons: string[] = [], conflicts: string[] = [];
  let score = 0;
  if (givenMatches && surnameMatches) {
    if (a.given === b.given && a.currentSurnames.length && b.currentSurnames.length &&
        a.currentSurnames.join(" ") === b.currentSurnames.join(" "))
      reasons.push("Совпадают имя и фамилия");
    else if (a.given === b.given && (a.birthSurnames.some((value) => b.surnames.includes(value)) ||
        b.birthSurnames.some((value) => a.surnames.includes(value))))
      reasons.push("Совпадают имя и фамилия при рождении");
    else if (a.given === b.given && a.currentSurnames.some((value) => b.currentSurnames.includes(value)))
      reasons.push("Совпадает имя и часть составной фамилии");
    else reasons.push("Похожи имя и фамилия (возможная опечатка)");
    score += 2;
  } else if (givenMatches) {
    reasons.push(a.given === b.given ? "Совпадает имя" : "Похоже имя (возможная опечатка)");
    if (!surnameMatches) conflicts.push("Указанные фамилии различаются");
    score += 1;
  }
  for (const [field, label] of [
    ["birthYear", "Год рождения"], ["deathYear", "Год смерти"],
  ] as const) {
    const left = Number(source[field]), right = Number(candidate[field]);
    if (!source[field] || !candidate[field] || !Number.isInteger(left) || !Number.isInteger(right)) continue;
    const difference = Math.abs(left - right);
    if (difference === 0) { reasons.push(`${label} совпадает`); score += 3; }
    else if (difference <= 2) { reasons.push(`${label} близок (±2 года)`); score += 1; }
    else conflicts.push(`${label} различается: ${source[field]} и ${candidate[field]}`);
  }
  for (const [field, label] of [
    ["birthPlace", "Место рождения"], ["deathPlace", "Место смерти"],
  ] as const) {
    const left = localityWords(source[field] || ""), right = localityWords(candidate[field] || "");
    if (!left.length || !right.length) continue;
    if (left.join(" ") === right.join(" ")) { reasons.push(`${label} совпадает`); score += 2; }
    else if (left.some((word) => right.includes(word))) {
      reasons.push(`${label} частично совпадает`); score += 1;
    } else conflicts.push(`${label} различается`);
  }
  return { reasons, conflicts, score: score - conflicts.length };
}
