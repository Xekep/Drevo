export type PublishedCandidate = {
  name: string; birthSurname?: string; birthYear?: string; deathYear?: string;
  birthPlace?: string; deathPlace?: string;
};
export type PublishedRelative = { kind: "parent" | "child" | "spouse"; name: string };

const words = (value: string) =>
  value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) || [];
function nameParts(person: PublishedCandidate) {
  const name = words(person.name);
  return { given: name[1] || "", surnames: [name[0], ...words(person.birthSurname || "")]
    .filter((value): value is string => Boolean(value)) };
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
export function candidatePlaceQuery(person: PublishedCandidate) {
  const given = nameParts(person).given;
  const field = person.birthPlace && /^\d{4}$/.test(person.birthYear || "")
    ? "birthYear" : "deathYear";
  const year = person[field];
  const locality = localityWords((field === "birthYear" ? person.birthPlace : person.deathPlace) || "")
    .filter((word) => word.length >= 4);
  if (given.length < 2 || !locality.length || !year || !/^\d{4}$/.test(year)) return null;
  return { terms: `${given} & ${locality.join(" & ")}`,
    column: field === "birthYear" ? "birth_year" as const : "death_year" as const,
    from: String(Math.max(1, Number(year) - 2)).padStart(4, "0"),
    to: String(Math.min(9999, Number(year) + 2)).padStart(4, "0") };
}
/** Only names from the opt-in relative projection may become lookup terms. */
export function candidateRelativeQuery(relatives: PublishedRelative[]): string | null {
  const terms = relatives.slice(0, 24).map(({ name }) => {
    const person = nameParts({ name });
    return person.given.length >= 2 && person.surnames[0]?.length >= 2
      ? `(${person.given} & ${person.surnames[0]})` : null;
  }).filter((term): term is string => Boolean(term));
  return terms.length ? [...new Set(terms)].join(" | ") : null;
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
function relativeMatch(source: PublishedRelative[], candidate: PublishedRelative[]) {
  return source.some((left) => candidate.some((right) => {
    if (left.kind !== right.kind) return false;
    const a = nameParts({ name: left.name });
    const b = nameParts({ name: right.name });
    return Boolean(a.given && a.given === b.given && a.surnames[0] === b.surnames[0]);
  }));
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
  sourceRelatives: PublishedRelative[] = [], candidateRelatives: PublishedRelative[] = [],
) {
  const a = nameParts(source), b = nameParts(candidate);
  const givenMatches = Boolean(a.given && b.given && similar(a.given, b.given));
  const surnameMatches = a.surnames.some((left) => b.surnames.some((right) => similar(left,right)));
  const relativesMatch = relativeMatch(sourceRelatives,candidateRelatives);
  const birthDifference = source.birthYear && candidate.birthYear
    ? Math.abs(Number(source.birthYear) - Number(candidate.birthYear)) : null;
  const placeOverlap = (["birthPlace","deathPlace"] as const).some((field) => {
    const left = localityWords(source[field] || ""), right = localityWords(candidate[field] || "");
    return left.some((word) => right.includes(word));
  });
  // A shared relative name alone is insufficient evidence of personal identity.
  if (!(givenMatches && surnameMatches) &&
      !(givenMatches && birthDifference !== null && birthDifference <= 2 && placeOverlap) &&
      !(relativesMatch && givenMatches && (birthDifference !== null && birthDifference <= 2 || placeOverlap)))
    return null;
  const reasons: string[] = [], conflicts: string[] = [];
  let score = 0;
  if (givenMatches && surnameMatches) {
    if (a.given === b.given && a.surnames[0] === b.surnames[0])
      reasons.push("Совпадают имя и фамилия");
    else if (a.given === b.given && a.surnames.some((value) => b.surnames.includes(value)))
      reasons.push("Совпадают имя и фамилия при рождении");
    else reasons.push("Похожи имя и фамилия (возможная опечатка)");
    score += 2;
  } else if (givenMatches) {
    reasons.push(a.given === b.given ? "Совпадает имя" : "Похоже имя (возможная опечатка)");
    if (!surnameMatches) conflicts.push("Указанные фамилии различаются");
    score += 1;
  }
  if (relativesMatch) { reasons.push("Совпадает опубликованный близкий родственник"); score += 2; }
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
