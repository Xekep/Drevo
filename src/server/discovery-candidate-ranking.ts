export type PublishedCandidate = {
  name: string;
  birthSurname?: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  deathPlace?: string;
};

const words = (value: string) =>
  value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) || [];

function nameParts(person: PublishedCandidate) {
  const name = words(person.name);
  return { given: name[1] || "", surnames: [name[0], ...words(person.birthSurname || "")]
    .filter((value): value is string => Boolean(value)) };
}

export function candidateNameQuery(person: PublishedCandidate): string | null {
  const { given, surnames } = nameParts(person);
  const surnameTerms = [...new Set(surnames.filter((value) => value.length >= 2))].slice(0, 4);
  if (given.length < 2 || !surnameTerms.length) return null;
  return `${given} & (${surnameTerms.join(" | ")})`;
}

export function candidateEvidence(source: PublishedCandidate, candidate: PublishedCandidate) {
  const sourceName = nameParts(source);
  const candidateName = nameParts(candidate);
  if (!sourceName.given || sourceName.given !== candidateName.given ||
      !sourceName.surnames.some((value) => candidateName.surnames.includes(value))) return null;
  const reasons = [sourceName.surnames[0] === candidateName.surnames[0]
    ? "Совпадают имя и фамилия" : "Совпадают имя и фамилия при рождении"];
  const conflicts: string[] = [];
  let score = 1;
  for (const [field, label] of [
    ["birthYear", "Год рождения"], ["deathYear", "Год смерти"],
  ] as const) {
    const left = Number(source[field]);
    const right = Number(candidate[field]);
    if (!source[field] || !candidate[field] || !Number.isInteger(left) || !Number.isInteger(right)) continue;
    const difference = Math.abs(left - right);
    if (difference === 0) { reasons.push(`${label} совпадает`); score += 3; }
    else if (difference <= 2) { reasons.push(`${label} близок (±2 года)`); score += 1; }
    else conflicts.push(`${label} различается: ${source[field]} и ${candidate[field]}`);
  }
  for (const [field, label] of [
    ["birthPlace", "Место рождения"], ["deathPlace", "Место смерти"],
  ] as const) {
    const left = words(source[field] || "").join(" ");
    const right = words(candidate[field] || "").join(" ");
    if (!left || !right) continue;
    if (left === right) { reasons.push(`${label} совпадает`); score += 2; }
    else conflicts.push(`${label} различается`);
  }
  return { reasons, conflicts, score: score - conflicts.length };
}
