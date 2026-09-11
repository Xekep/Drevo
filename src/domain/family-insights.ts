import {
  dateYear,
  fullName,
  hasRecordedDeath,
  plural,
  validDate,
} from "./dates.ts";
import type { Family, Person } from "./types.ts";

type InsightFact = {
  title: string;
  value: string;
  detail: string;
  personIds?: string[];
};

type InsightWarning = {
  title: string;
  detail: string;
  personIds: string[];
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
  warnings: InsightWarning[];
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
        pairs.set(key, ids[0] === person.id ? [person, spouse] : [spouse, person]);
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
          death = yearOf(person.death);
        return birth !== null && death !== null && death >= birth
          ? [death - birth]
          : [];
      });
      return {
        generation,
        people: group.length,
        knownBirths: group.filter((person) => yearOf(person.birth) !== null).length,
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

function warningKey(ids: string[], title: string) {
  return `${title}:${[...ids].sort().join(":")}`;
}

function dataWarnings(people: Person[]) {
  const peopleMap = new Map(people.map((person) => [person.id, person])),
    warnings = new Map<string, InsightWarning>();
  const add = (warning: InsightWarning) =>
    warnings.set(warningKey(warning.personIds, warning.title), warning);

  for (const person of people) {
    const birth = yearOf(person.birth),
      death = yearOf(person.death);
    if (birth !== null && death !== null && death < birth)
      add({
        title: "Дата смерти раньше рождения",
        detail: fullName(person),
        personIds: [person.id],
      });

    for (const parentId of new Set(person.parents)) {
      const parent = peopleMap.get(parentId),
        childBirth = birth,
        parentBirth = parent ? yearOf(parent.birth) : null,
        parentDeath = parent ? yearOf(parent.death) : null;
      if (!parent || childBirth === null || parentBirth === null) continue;
      const age = childBirth - parentBirth;
      if (age < 12)
        add({
          title: "Очень маленький возраст родителя",
          detail: `${fullName(parent)} — около ${age} ${plural(age, "года", "лет", "лет")} при рождении ${fullName(person)}`,
          personIds: [parent.id, person.id],
        });
      else if (age > 80)
        add({
          title: "Необычно большой возраст родителя",
          detail: `${fullName(parent)} — около ${age} лет при рождении ${fullName(person)}`,
          personIds: [parent.id, person.id],
        });
      if (parentDeath !== null && parentDeath < childBirth - 1)
        add({
          title: "Ребёнок родился заметно позже смерти родителя",
          detail: `${fullName(parent)} умер в ${parentDeath}, ${fullName(person)} родился в ${childBirth}`,
          personIds: [parent.id, person.id],
        });
    }
  }

  const duplicates = new Map<string, Person[]>();
  for (const person of people) {
    const birth = yearOf(person.birth),
      name = normalized(fullName(person));
    if (!name || birth === null) continue;
    const key = `${name}:${birth}`,
      group = duplicates.get(key) || [];
    group.push(person);
    duplicates.set(key, group);
  }
  for (const group of duplicates.values())
    if (group.length > 1)
      add({
        title: "Возможный дубль",
        detail: `${fullName(group[0])}, ${yearOf(group[0].birth)}: ${group.length} записи`,
        personIds: group.map((person) => person.id),
      });

  return [...warnings.values()].slice(0, 20);
}

export function analyzeFamilyInsights(
  family: Family,
  currentYear = new Date().getFullYear(),
): FamilyInsights {
  const people = family.people,
    peopleMap = new Map(people.map((person) => [person.id, person])),
    children = childCounts(people),
    spousePairs = uniqueSpousePairs(people),
    lifespans = people.flatMap((person) => {
      const birth = yearOf(person.birth),
        death = yearOf(person.death);
      return birth !== null && death !== null && death >= birth
        ? [{ person, age: death - birth }]
        : [];
    }),
    knownBirths = people.flatMap((person) => {
      const year = yearOf(person.birth);
      return year === null ? [] : [{ person, year }];
    }),
    topSurnames = topValues(people.map((person) => person.surname)),
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
      title: "Долгожитель дерева",
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
      detail: `${topSurnames[0].count} ${plural(topSurnames[0].count, "человек", "человека", "человек")} в дереве`,
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

  const deceased = people.filter(hasRecordedDeath),
    hasSources = people.filter(
      (person) =>
        person.sources.length > 0 ||
        (person.events || []).some((event) => event.sources?.length) ||
        (person.awards || []).some((award) => award.source),
    ).length;

  return {
    facts,
    warnings: dataWarnings(people),
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
        value: deceased.filter((person) => yearOf(person.death) !== null).length,
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
      generations: new Set(people.map((person) => person.generation)).size,
      photos: photos.length,
      events: eventCount,
      sources: sourceCount,
    },
  };
}
