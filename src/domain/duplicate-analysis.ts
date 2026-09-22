import { fullName } from "./dates.ts";
import type { Person } from "./types.ts";

export type PossibleDuplicate = {
  score: number;
  confidence: "high" | "medium";
  people: [
    { id: string; name: string; birth: string; birthPlace: string },
    { id: string; name: string; birth: string; birthPlace: string },
  ];
  reasons: string[];
  conflicts: string[];
};

const ruToLatin: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ы: "y",
  э: "e",
  ю: "yu",
  я: "ya",
  ь: "",
  ъ: "",
};

function normalized(value?: string) {
  return (value || "")
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ");
}

function latinKey(value?: string) {
  return [...normalized(value)]
    .map((char) => ruToLatin[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

function year(value?: string) {
  const match = value?.match(/(?:^|\D)(\d{4})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function distanceAtMostTwo(a: string, b: string) {
  if (a === b) return 0;
  if (!a || !b || Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > 2) return 3;
    previous = current;
  }
  return previous[b.length] <= 2 ? previous[b.length] : 3;
}

function placeSimilarity(a?: string, b?: string) {
  const left = normalized(a),
    right = normalized(b);
  if (!left || !right) return 0;
  if (left === right) return 2;
  if (left.includes(right) || right.includes(left)) return 1;
  const leftTokens = new Set(
      left.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3),
    ),
    rightTokens = new Set(
      right.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3),
    );
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common++;
  return common >= 1 ? 1 : -1;
}

function surnameKeys(person: Person) {
  return [...new Set([person.surname, person.maidenName || ""].map(latinKey).filter(Boolean))];
}

function surnameSimilarity(a: Person, b: Person) {
  let best = 3;
  for (const left of surnameKeys(a))
    for (const right of surnameKeys(b))
      best = Math.min(best, distanceAtMostTwo(left, right));
  return best;
}

function overlapping(a: string[], b: string[]) {
  const right = new Set(b);
  return a.filter((value) => right.has(value)).length;
}

function scorePair(a: Person, b: Person): PossibleDuplicate | null {
  if (a.id === b.id) return null;
  if (a.sex !== "u" && b.sex !== "u" && a.sex !== b.sex) return null;

  const reasons: string[] = [],
    conflicts: string[] = [];
  let score = 0;

  const firstA = latinKey(a.name),
    firstB = latinKey(b.name),
    firstDistance = distanceAtMostTwo(firstA, firstB);
  if (firstA && firstA === firstB) {
    score += 30;
    reasons.push("совпадает имя");
  } else if (
    firstA.length >= 4 &&
    firstB.length >= 4 &&
    firstDistance === 1
  ) {
    score += 22;
    reasons.push("имена отличаются одной буквой");
  } else return null;

  const surnameDistance = surnameSimilarity(a, b);
  if (surnameDistance === 0) {
    score += 35;
    reasons.push("совпадает фамилия или фамилия при рождении");
  } else if (surnameDistance === 1) {
    score += 27;
    reasons.push("фамилии отличаются одной буквой");
  } else if (
    surnameDistance === 2 &&
    Math.min(...surnameKeys(a).map((value) => value.length), 0 || Infinity) >= 6 &&
    Math.min(...surnameKeys(b).map((value) => value.length), 0 || Infinity) >= 6
  ) {
    score += 18;
    reasons.push("фамилии близки по написанию");
  } else return null;

  const patronymicA = latinKey(a.patronymic),
    patronymicB = latinKey(b.patronymic);
  if (patronymicA && patronymicB) {
    const patronymicDistance = distanceAtMostTwo(patronymicA, patronymicB);
    if (patronymicDistance === 0) {
      score += 14;
      reasons.push("совпадает отчество");
    } else if (patronymicDistance === 1) {
      score += 8;
      reasons.push("отчества отличаются одной буквой");
    } else {
      score -= 12;
      conflicts.push("отчества различаются");
    }
  }

  const birthA = year(a.birth),
    birthB = year(b.birth);
  if (birthA !== null && birthB !== null) {
    const gap = Math.abs(birthA - birthB);
    if (gap === 0) {
      score += 18;
      reasons.push("совпадает год рождения");
    } else if (gap === 1) {
      score += 12;
      reasons.push("годы рождения отличаются на 1 год");
    } else if (gap === 2) {
      score += 6;
      reasons.push("годы рождения отличаются на 2 года");
    } else if (gap >= 6) {
      score -= 28;
      conflicts.push(`годы рождения различаются на ${gap}`);
    } else {
      score -= 8;
      conflicts.push(`годы рождения различаются на ${gap}`);
    }
  } else {
    reasons.push("в одной из карточек год рождения неизвестен");
  }

  const birthPlace = placeSimilarity(a.birthPlace, b.birthPlace);
  if (birthPlace === 2) {
    score += 12;
    reasons.push("совпадает место рождения");
  } else if (birthPlace === 1) {
    score += 8;
    reasons.push("места рождения частично совпадают");
  } else if (birthPlace === -1) {
    score -= 4;
    conflicts.push("указаны разные места рождения");
  }

  const deathA = year(a.death),
    deathB = year(b.death);
  if (deathA !== null && deathB !== null) {
    const gap = Math.abs(deathA - deathB);
    if (gap === 0) {
      score += 8;
      reasons.push("совпадает год смерти");
    } else if (gap >= 4) {
      score -= 12;
      conflicts.push("годы смерти заметно различаются");
    }
  }

  const commonParents = overlapping(a.parents, b.parents);
  if (commonParents) {
    score += Math.min(24, commonParents * 12);
    reasons.push(
      commonParents === 1
        ? "совпадает один родитель"
        : "совпадают родители",
    );
  }

  const commonSpouses = overlapping(a.spouses, b.spouses);
  if (commonSpouses) {
    score += 14;
    reasons.push("совпадает супруг");
  }

  if (score < 65) return null;
  return {
    score: Math.min(100, score),
    confidence: score >= 82 ? "high" : "medium",
    people: [
      {
        id: a.id,
        name: fullName(a),
        birth: a.birth,
        birthPlace: a.birthPlace,
      },
      {
        id: b.id,
        name: fullName(b),
        birth: b.birth,
        birthPlace: b.birthPlace,
      },
    ],
    reasons,
    conflicts,
  };
}

function candidatePairs(people: Person[]) {
  const byName = new Map<string, Person[]>(),
    bySignature = new Map<string, Person[]>(),
    pairs = new Map<string, [Person, Person]>();
  const signature = (key: string, length = key.length) =>
    `${key.slice(0, 1)}:${length}`;

  for (const person of people) {
    const key = latinKey(person.name);
    if (!key) continue;

    const candidates = new Map<string, Person>();
    for (const other of byName.get(key) || []) candidates.set(other.id, other);
    if (key.length >= 4)
      for (const length of [key.length - 1, key.length, key.length + 1])
        for (const other of bySignature.get(signature(key, length)) || [])
          candidates.set(other.id, other);

    for (const other of candidates.values()) {
      const otherKey = latinKey(other.name);
      if (
        otherKey !== key &&
        distanceAtMostTwo(otherKey, key) !== 1
      )
        continue;
      const ids = [person.id, other.id].sort();
      pairs.set(
        `${ids[0]}:\0${ids[1]}`,
        ids[0] === person.id ? [person, other] : [other, person],
      );
    }

    const exactBucket = byName.get(key) || [];
    exactBucket.push(person);
    byName.set(key, exactBucket);
    const signatureKey = signature(key),
      signatureBucket = bySignature.get(signatureKey) || [];
    signatureBucket.push(person);
    bySignature.set(signatureKey, signatureBucket);
  }
  return [...pairs.values()];
}

export function findPossibleDuplicates(
  people: Person[],
  personId?: string,
  limit = 30,
) {
  const target = personId
    ? people.find((person) => person.id === personId)
    : undefined;
  if (personId && !target)
    throw new Error("Человек не найден или недоступен");

  const pairs = target
    ? people
        .filter((person) => person.id !== target.id)
        .map((person) => [target, person] as [Person, Person])
    : candidatePairs(people);

  const matches = pairs
    .flatMap(([a, b]) => {
      const match = scorePair(a, b);
      return match ? [match] : [];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.people[0].name.localeCompare(b.people[0].name, "ru") ||
        a.people[1].name.localeCompare(b.people[1].name, "ru"),
    )
    .slice(0, limit);

  return {
    matches,
    total: matches.length,
    threshold: 65,
    note:
      "Это вероятные совпадения для ручной проверки, а не утверждение, что записи относятся к одному человеку.",
  };
}
