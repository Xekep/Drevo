import {
  dateBound,
  dateYear,
  fullName,
  hasRecordedDeath,
  plural,
  validDate,
} from "./dates.ts";
import { archiveSummary } from "./archive-summary.ts";
import {
  analyzeArchiveWarnings,
  type ArchiveWarning,
} from "./archive-quality.ts";
import type { Family, Person } from "./types.ts";

type InsightFact = {
  title: string;
  value: string;
  detail: string;
  personIds?: string[];
};

type InsightCompleteness = {
  label: string;
  value: number;
  total: number;
};

type InsightGeneration = {
  generation: number;
  people: number;
  knownBirths: number;
  averageLifespan?: number;
};

export type FamilyInsights = {
  facts: InsightFact[];
  warnings: ArchiveWarning[];
  completeness: InsightCompleteness[];
  generations: InsightGeneration[];
  topSurnames: { label: string; count: number }[];
  topNames: { label: string; count: number }[];
  totals: {
    people: number;
    generations: number;
    photos: number;
    events: number;
    sources: number;
  };
};

const yearOf = (value?: string) =>
  value && validDate(value) ? dateYear(value) : null;

function completedLifespans(people: Person[]) {
  return people.flatMap((person) => {
    const birth = yearOf(person.birth),
      death = yearOf(person.death),
      age = birth !== null && death !== null ? death - birth : null;
    return age !== null && age >= 0 ? [{ person, age }] : [];
  });
}

/** A hint, never evidence of death. Year-only births use the youngest possible age. */
export function deceasedStatusSuggestion(
  family: Family,
  candidate: Pick<Person, "birth" | "death" | "deathPlace" | "deceased">,
  today = new Date().toISOString().slice(0, 10),
) {
  if (
    hasRecordedDeath(candidate) ||
    !validDate(candidate.birth) ||
    !validDate(today) ||
    today.length !== 10
  )
    return null;
  const ages = completedLifespans(family.people)
    .filter(({ age }) => age >= 18)
    .map(({ age }) => age);
  if (ages.length < 5) return null;
  const averageYears =
    Math.round((ages.reduce((sum, age) => sum + age, 0) / ages.length) * 10) /
    10;
  const latestBirth = dateBound(candidate.birth, true);
  const ageAtLeast =
    Number(today.slice(0, 4)) -
    Number(candidate.birth.slice(0, 4)) -
    Number(today.slice(5) < latestBirth.slice(5));
  return ageAtLeast > averageYears + 10
    ? { ageAtLeast, averageYears, sampleSize: ages.length }
    : null;
}

const normalized = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");

function topValues(values: string[], limit = 6) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const value of values) {
    const label = value.trim();
    if (!label) continue;
    const key = normalized(label);
    const current = counts.get(key);
    if (current) current.count++;
    else counts.set(key, { label, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"))
    .slice(0, limit);
}

function rankSurnames(people: Person[], limit = 6) {
  const counts = new Map<string, { label: string; count: number }>(),
    maleForms = new Map(
      people
        .filter((person) => person.sex === "m" && person.surname.trim())
        .map((person) => [normalized(person.surname), person.surname.trim()]),
    );
  for (const person of people) {
    const original = person.surname.trim();
    if (!original) continue;
    let label = original;
    if (person.sex === "f" && !maleForms.has(normalized(original))) {
      const candidates = /[сц]кая$/iu.test(original)
        ? [`${original.slice(0, -2)}ий`]
        : original.length >= 5 && /(?:ова|ева|ёва|ина|ына)$/iu.test(original)
          ? [original.slice(0, -1)]
          : /яя$/iu.test(original)
            ? [`${original.slice(0, -2)}ий`]
            : /ая$/iu.test(original)
              ? ["ый", "ий", "ой"].map(
                  (ending) => `${original.slice(0, -2)}${ending}`,
                )
              : [];
      const recorded = candidates.find((candidate) =>
        maleForms.has(normalized(candidate)),
      );
      label = recorded
        ? maleForms.get(normalized(recorded))!
        : /ая$/iu.test(original) && !/[сц]кая$/iu.test(original)
          ? original
          : candidates[0] || original;
    }
    const key = normalized(label);
    const current = counts.get(key);
    if (current) {
      current.count++;
      if (person.sex === "m") current.label = original;
    } else counts.set(key, { label, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"))
    .slice(0, limit);
}

function childCounts(people: Person[]) {
  const counts = new Map<string, number>();
  for (const child of people)
    for (const parent of new Set(child.parents))
      counts.set(parent, (counts.get(parent) || 0) + 1);
  return counts;
}

function uniqueSpousePairs(people: Person[]) {
  const pairs = new Map<string, [Person, Person]>(),
    peopleMap = new Map(people.map((person) => [person.id, person]));
  for (const person of people)
    for (const spouseId of person.spouses) {
      const spouse = peopleMap.get(spouseId);
      if (!spouse) continue;
      const ids = [person.id, spouse.id].sort();
      const key = `${ids[0]}:${ids[1]}`;
      if (!pairs.has(key))
        pairs.set(
          key,
          ids[0] === person.id ? [person, spouse] : [spouse, person],
        );
    }
  return [...pairs.values()];
}

function peakLiving(people: Person[], currentYear: number) {
  const totalDelta = new Map<number, number>(),
    generationDelta = new Map<number, Map<number, number>>();
  let minYear = Infinity,
    maxYear = -Infinity;
  const add = (year: number, value: number, generation: number) => {
    totalDelta.set(year, (totalDelta.get(year) || 0) + value);
    const generations = generationDelta.get(year) || new Map<number, number>();
    generations.set(generation, (generations.get(generation) || 0) + value);
    generationDelta.set(year, generations);
  };
  for (const person of people) {
    const birth = yearOf(person.birth);
    if (birth === null) continue;
    const death = yearOf(person.death);
    if (hasRecordedDeath(person) && death === null) continue;
    const end = death ?? currentYear;
    if (end < birth) continue;
    minYear = Math.min(minYear, birth);
    maxYear = Math.max(maxYear, end);
    add(birth, 1, person.generation);
    add(end + 1, -1, person.generation);
  }
  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear)) return null;
  let living = 0,
    peak = 0,
    peakYear = minYear,
    peakGenerations = 0,
    peakGenerationsYear = minYear;
  const generations = new Map<number, number>();
  for (let year = minYear; year <= maxYear; year++) {
    living += totalDelta.get(year) || 0;
    for (const [generation, change] of generationDelta.get(year) || []) {
      const next = (generations.get(generation) || 0) + change;
      if (next > 0) generations.set(generation, next);
      else generations.delete(generation);
    }
    if (living > peak) {
      peak = living;
      peakYear = year;
    }
    if (generations.size > peakGenerations) {
      peakGenerations = generations.size;
      peakGenerationsYear = year;
    }
  }
  return { peak, peakYear, peakGenerations, peakGenerationsYear };
}

function generationStats(people: Person[]): InsightGeneration[] {
  const grouped = new Map<number, Person[]>();
  for (const person of people) {
    const group = grouped.get(person.generation) || [];
    group.push(person);
    grouped.set(person.generation, group);
  }
  return [...grouped]
    .sort(([a], [b]) => a - b)
    .map(([generation, group]) => {
      const lifespans = group.flatMap((person) => {
        const birth = yearOf(person.birth),
          death = yearOf(person.death),
          age = birth !== null && death !== null ? death - birth : null;
        return age !== null && age >= 18 ? [age] : [];
      });
      return {
        generation,
        people: group.length,
        knownBirths: group.filter((person) => yearOf(person.birth) !== null)
          .length,
        ...(lifespans.length
          ? {
              averageLifespan: Math.round(
                lifespans.reduce((sum, age) => sum + age, 0) / lifespans.length,
              ),
            }
          : {}),
      };
    });
}

export function analyzeFamilyInsights(
  family: Family,
  currentYear = new Date().getFullYear(),
): FamilyInsights {
  const people = family.people,
    peopleMap = new Map(people.map((person) => [person.id, person])),
    children = childCounts(people),
    spousePairs = uniqueSpousePairs(people),
    lifespans = completedLifespans(people),
    adultLifespans = lifespans.filter(({ age }) => age >= 18),
    knownBirths = people.flatMap((person) => {
      const year = yearOf(person.birth);
      return year === null ? [] : [{ person, year }];
    }),
    topSurnames = rankSurnames(people),
    topNames = topValues(people.map((person) => person.name)),
    peak = peakLiving(people, currentYear),
    photos = family.photos || [],
    eventCount = people.reduce(
      (sum, person) => sum + (person.events?.length || 0),
      0,
    ),
    sourceCount = people.reduce(
      (sum, person) =>
        sum +
        person.sources.length +
        (person.events || []).reduce(
          (eventSum, event) => eventSum + (event.sources?.length || 0),
          0,
        ),
      0,
    );

  const facts: InsightFact[] = [];
  const earliest = knownBirths.sort((a, b) => a.year - b.year)[0];
  if (earliest)
    facts.push({
      title: "Самое раннее известное рождение",
      value: String(earliest.year),
      detail: fullName(earliest.person),
      personIds: [earliest.person.id],
    });

  const longest = lifespans.sort((a, b) => b.age - a.age)[0];
  if (longest)
    facts.push({
      title: "Самая долгая жизнь",
      value: `${longest.age} ${plural(longest.age, "год", "года", "лет")}`,
      detail: fullName(longest.person),
      personIds: [longest.person.id],
    });

  const biggestFamily = [...children].sort((a, b) => b[1] - a[1])[0];
  if (biggestFamily && peopleMap.has(biggestFamily[0])) {
    const parent = peopleMap.get(biggestFamily[0])!;
    facts.push({
      title: "Больше всего детей",
      value: `${biggestFamily[1]} ${plural(biggestFamily[1], "ребёнок", "ребёнка", "детей")}`,
      detail: fullName(parent),
      personIds: [parent.id],
    });
  }

  if (peak?.peak)
    facts.push({
      title: "Больше всего родственников жили одновременно",
      value: String(peak.peak),
      detail: `Пик приходится на ${peak.peakYear} год`,
    });
  if (peak?.peakGenerations)
    facts.push({
      title: "Поколений одновременно",
      value: String(peak.peakGenerations),
      detail: `Такое пересечение видно около ${peak.peakGenerationsYear} года`,
    });

  const spouseGap = spousePairs
    .flatMap(([a, b]) => {
      const ay = yearOf(a.birth),
        by = yearOf(b.birth);
      return ay === null || by === null
        ? []
        : [{ a, b, gap: Math.abs(ay - by) }];
    })
    .sort((a, b) => b.gap - a.gap)[0];
  if (spouseGap)
    facts.push({
      title: "Самая большая разница в возрасте супругов",
      value: `${spouseGap.gap} ${plural(spouseGap.gap, "год", "года", "лет")}`,
      detail: `${fullName(spouseGap.a)} и ${fullName(spouseGap.b)}`,
      personIds: [spouseGap.a.id, spouseGap.b.id],
    });

  if (topSurnames[0])
    facts.push({
      title: "Самая частая фамилия",
      value: topSurnames[0].label,
      detail: `${topSurnames[0].count} ${plural(topSurnames[0].count, "человек", "человека", "человек")} в древе`,
    });

  const places = topValues(
    people.flatMap((person) => [
      person.birthPlace,
      person.deathPlace || "",
      ...(person.events || []).map((event) => event.place || ""),
    ]),
    1,
  );
  if (places[0])
    facts.push({
      title: "Самое часто упоминаемое место",
      value: places[0].label,
      detail: `${places[0].count} упоминаний в сведениях о людях`,
    });

  for (const [sex, label] of [
    ["m", "мужчин"],
    ["f", "женщин"],
  ] as const) {
    const ages = adultLifespans
      .filter(({ person }) => person.sex === sex)
      .map(({ age }) => age);
    const average = ages.length
      ? Math.round(
          (ages.reduce((sum, age) => sum + age, 0) / ages.length) * 10,
        ) / 10
      : null;
    facts.push({
      title: `Средняя продолжительность жизни ${label}`,
      value:
        average === null
          ? "Нет данных"
          : `≈ ${average.toLocaleString("ru-RU")} ${Number.isInteger(average) ? plural(average, "год", "года", "лет") : "года"}`,
      detail: ages.length
        ? `${ages.length} ${plural(ages.length, "человек", "человека", "человек")} с известными годами рождения и смерти`
        : "Нет записей с известными годами рождения и смерти",
    });
  }

  const deceased = people.filter(hasRecordedDeath),
    hasSources = people.filter(
      (person) =>
        person.sources.length > 0 ||
        (person.events || []).some((event) => event.sources?.length) ||
        (person.awards || []).some((award) => award.source),
    ).length;

  return {
    facts,
    warnings: analyzeArchiveWarnings(family),
    completeness: [
      {
        label: "Дата рождения",
        value: people.filter((person) => yearOf(person.birth) !== null).length,
        total: people.length,
      },
      {
        label: "Место рождения",
        value: people.filter((person) => person.birthPlace.trim()).length,
        total: people.length,
      },
      {
        label: "Дата смерти у умерших",
        value: deceased.filter((person) => yearOf(person.death) !== null)
          .length,
        total: deceased.length,
      },
      {
        label: "Источники",
        value: hasSources,
        total: people.length,
      },
      {
        label: "Портрет",
        value: people.filter((person) => person.photo).length,
        total: people.length,
      },
      {
        label: "События жизни",
        value: people.filter((person) => person.events?.length).length,
        total: people.length,
      },
    ],
    generations: generationStats(people),
    topSurnames,
    topNames,
    totals: {
      people: people.length,
      // Та же метрика, что в шапке древа: самая длинная подтверждённая
      // цепочка родителей и детей.
      generations: archiveSummary(people).generations || 0,
      photos: photos.length,
      events: eventCount,
      sources: sourceCount,
    },
  };
}
