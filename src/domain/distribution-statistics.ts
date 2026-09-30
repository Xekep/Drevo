import type { Family, Person } from "./types.ts";

export const DISTRIBUTION_DIMENSIONS = [
  "surname",
  "generation",
  "sex",
  "birth_decade",
  "birth_place",
  "known_parents",
] as const;
export type DistributionDimension = (typeof DISTRIBUTION_DIMENSIONS)[number];

/** Exact, bounded aggregation over the authorized family, never generated code. */
export function distributionStatistics(
  family: Family,
  dimension: DistributionDimension,
) {
  if (!DISTRIBUTION_DIMENSIONS.includes(dimension))
    throw new Error("Неизвестный признак распределения");
  const category = (person: Person): string | null => {
    switch (dimension) {
      case "surname":
        return person.surname.trim().toLocaleLowerCase("ru-RU") || null;
      case "generation":
        return Number.isInteger(person.generation)
          ? String(person.generation)
          : null;
      case "sex":
        return person.sex === "u" ? null : person.sex;
      case "birth_decade": {
        const year = /^(\d{4})(?:-|$)/.exec(person.birth)?.[1];
        return year ? String(Math.floor(Number(year) / 10) * 10) : null;
      }
      case "birth_place":
        return person.birthPlace.trim().toLocaleLowerCase("ru-RU") || null;
      case "known_parents":
        return String(
          new Set(person.parents.filter((id) => visibleIds.has(id))).size,
        );
    }
  };
  const visibleIds = new Set(family.people.map((person) => person.id));
  const buckets = new Map<string, number>();
  let missing = 0;
  for (const person of family.people) {
    const value = category(person);
    if (value === null) missing++;
    else buckets.set(value, (buckets.get(value) || 0) + 1);
  }
  const sampleSize = family.people.length - missing;
  const counts = [...buckets].map(([label, count]) => ({ label, count }));
  counts.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"),
  );
  const entropyBits = sampleSize
    ? counts.reduce((sum, { count }) => {
        const probability = count / sampleSize;
        return sum - probability * Math.log2(probability);
      }, 0)
    : null;
  const maxEntropyBits = buckets.size ? Math.log2(buckets.size) : null;
  return {
    dimension,
    totalPeople: family.people.length,
    sampleSize,
    missing,
    categoryCount: buckets.size,
    entropyBits,
    maxEntropyBits,
    normalizedEntropy:
      entropyBits === null
        ? null
        : maxEntropyBits
          ? entropyBits / maxEntropyBits
          : 0,
    formula: "H = -sum(p_i * log2(p_i)); p_i = count_i / sampleSize",
    buckets: counts.slice(0, 50),
    truncated: counts.length > 50,
    displayedCount: counts
      .slice(0, 50)
      .reduce((sum, item) => sum + item.count, 0),
    note: "Расчёт по всей доступной выборке, а не по первым карточкам. Неизвестные значения исключены и указаны в missing. Фамилии и места сравниваются после удаления пробелов по краям и приведения регистра, без объединения вариантов написания. Это энтропия выбранного распределения, не универсальная энтропия древа и не мера достоверности или качества исследования. known_parents считает только связи внутри доступной выборки.",
  };
}
