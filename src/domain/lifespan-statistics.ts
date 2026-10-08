import { dateBound, dateYear, validDate } from "./dates.ts";
import type { Family, Person } from "./types.ts";

/** The same recorded adult sample powers the summary and chronology hints. */
export function averageAdultLifespansBySex(people: readonly Person[], currentYear: number) {
  const samples = { m: { total: 0, count: 0 }, f: { total: 0, count: 0 } };
  for (const person of people) {
    if ((person.sex !== "m" && person.sex !== "f") ||
      !validDate(person.birth) || !validDate(person.death)) continue;
    const death = dateYear(person.death);
    const age = death - dateYear(person.birth);
    if (age < 18 || death < currentYear - 100 || death > currentYear) continue;
    samples[person.sex].total += age;
    samples[person.sex].count++;
  }
  const result = (sex: "m" | "f") => ({
    averageYears: samples[sex].count
      ? Math.round(samples[sex].total / samples[sex].count * 10) / 10 : null,
    sampleSize: samples[sex].count,
  });
  return { m: result("m"), f: result("f") };
}

/** Completed lives only. Partial dates keep their age uncertainty explicit. */
export function lifespanStatistics(family: Family, adultsOnly = false) {
  const groups = new Map<number, { ages: number[]; approximate: number }>();
  const excluded = { missingDates: 0, invalidDates: 0, youngerThan18: 0 };
  function completedYears(birth: string, death: string) {
    return (
      Number(death.slice(0, 4)) -
      Number(birth.slice(0, 4)) -
      Number(death.slice(5) < birth.slice(5))
    );
  }
  for (const person of family.people) {
    if (!person.birth || !person.death) {
      excluded.missingDates++;
      continue;
    }
    if (
      !validDate(person.birth) ||
      !validDate(person.death) ||
      dateBound(person.death, true) < dateBound(person.birth, false)
    ) {
      excluded.invalidDates++;
      continue;
    }
    const min = Math.max(
      0,
      completedYears(
        dateBound(person.birth, true),
        dateBound(person.death, false),
      ),
    );
    const max = completedYears(
      dateBound(person.birth, false),
      dateBound(person.death, true),
    );
    if (adultsOnly && min < 18) {
      excluded.youngerThan18++;
      continue;
    }
    const group = groups.get(person.generation) || { ages: [], approximate: 0 };
    group.ages.push((min + max) / 2);
    group.approximate += Number(min !== max);
    groups.set(person.generation, group);
  }
  const byGeneration = [...groups]
    .sort(([a], [b]) => a - b)
    .map(([generation, group]) => ({
      generation,
      sampleSize: group.ages.length,
      approximateDates: group.approximate,
      averageYears:
        Math.round(
          (group.ages.reduce((a, b) => a + b, 0) / group.ages.length) * 10,
        ) / 10,
    }));
  const sampleSize = byGeneration.reduce(
    (sum, group) => sum + group.sampleSize,
    0,
  );
  const approximateDates = byGeneration.reduce(
    (sum, group) => sum + group.approximateDates,
    0,
  );
  const title = adultsOnly
    ? "Продолжительность жизни взрослых по поколениям"
    : "Продолжительность жизни по поколениям";
  return {
    totalPeople: family.people.length,
    sampleSize,
    approximateDates,
    adultsOnly,
    excluded,
    byGeneration,
    method:
      "Только записи с датами рождения и смерти; живущие и записи без дат исключены. Возраст в полных годах; для неполных дат используется середина диапазона возможного возраста. adultsOnly включает лишь возраст с нижней границей не меньше 18 лет. Это описание архива, а не ожидаемая продолжительность жизни населения.",
    mermaid:
      byGeneration.length && byGeneration.length <= 100
        ? `xychart-beta\n  title "${title}"\n  x-axis [${byGeneration.map((g) => `"${g.generation}-е поколение (n=${g.sampleSize})"`).join(", ")}]\n  y-axis "Лет"\n  bar [${byGeneration.map((g) => g.averageYears).join(", ")}]`
        : "",
  };
}
