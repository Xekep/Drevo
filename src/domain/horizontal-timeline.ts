import { ageLabel, dateYear, hasRecordedDeath, plural, validDate } from "./dates.ts";
import { averageAdultLifespansBySex } from "./lifespan-statistics.ts";
import { ERAS } from "./layout.ts";
import { EVENT_NAMES } from "./person-events.ts";
import type { Person } from "./types.ts";

const YEAR_WIDTH = 12;
const EVENT_WIDTH = 172;
const EVENT_GAP = 10;
const EVENT_LANE_HEIGHT = 68;

export type TimelineItem = {
  id: string;
  year: number | null;
  date: string;
  title: string;
  place?: string;
  age?: string;
  kind: "birth" | "death" | "event" | "award";
  estimated?: boolean;
  description?: string;
};
export type TimelineGroup = {
  year: number;
  items: TimelineItem[];
  x: number;
  lane: number;
};
export type TimelineRow = {
  person: Person;
  status: string;
  groups: TimelineGroup[];
  undated: TimelineItem[];
  height: number;
  birthYear: number | null;
  deathYear: number | null;
  estimatedDeath?: { year: number; averageYears: number; sampleSize: number };
};

/** Display estimates affect chronology only, never stored dates or statistics. */
export function timelineRowsAtYear(
  rows: readonly TimelineRow[],
  year: number,
  currentYear = new Date().getFullYear(),
): TimelineRow[] {
  return rows.filter((row) => {
    const end = row.deathYear ?? row.estimatedDeath?.year ?? null;
    return row.birthYear !== null &&
      row.birthYear <= year &&
      (end === null ? !hasRecordedDeath(row.person) || year < currentYear : end >= year);
  });
}

function estimatedDeath(
  person: Person,
  currentYear: number,
  averages: ReturnType<typeof averageAdultLifespansBySex>,
  lastChildBirth?: number,
): TimelineRow["estimatedDeath"] {
  if (!hasRecordedDeath(person) || person.death || !validDate(person.birth) ||
    (person.sex !== "m" && person.sex !== "f")) return;
  const { averageYears, sampleSize } = averages[person.sex];
  if (averageYears === null) return;
  const birth = dateYear(person.birth);
  let earliest = Math.max(birth, lastChildBirth === undefined ? birth
    : lastChildBirth - Number(person.sex === "m")), latest = currentYear;
  for (const event of person.events || []) {
    if (event.type === "other") continue;
    if (event.type === "burial") {
      const date = validDate(event.endDate) ? event.endDate : event.date;
      if (validDate(date)) latest = Math.min(latest, dateYear(date));
      continue;
    }
    for (const date of [event.date, event.endDate]) {
      if (!validDate(date)) continue;
      const year = dateYear(date);
      earliest = Math.max(earliest, year);
    }
  }
  if (earliest > latest) return;
  return {
    year: Math.max(earliest, Math.min(latest, birth + Math.round(averageYears + 10))),
    averageYears,
    sampleSize,
  };
}

function personItems(person: Person, estimate: TimelineRow["estimatedDeath"]): TimelineItem[] {
  const items: TimelineItem[] = [];
  if (person.birth)
    items.push({
      id: `${person.id}:birth`,
      year: dateYear(person.birth),
      date: person.birth,
      title: "Рождение",
      place: person.birthPlace || undefined,
      kind: "birth",
    });
  for (const event of person.events || [])
    items.push({
      id: `${person.id}:event:${event.id}`,
      year: validDate(event.date) ? dateYear(event.date) : null,
      date: event.dateText || event.date || "Без даты",
      title: event.title || EVENT_NAMES[event.type],
      place: event.place,
      kind: "event",
    });
  for (const award of person.awards || [])
    items.push({
      id: `${person.id}:award:${award.id}`,
      year: /^\d{4}$/.test(award.year || "") ? Number(award.year) : null,
      date: award.year || "Без даты",
      title: award.name,
      kind: "award",
    });
  if (person.death)
    items.push({
      id: `${person.id}:death`,
      year: validDate(person.death) ? dateYear(person.death) : null,
      date: person.death,
      title: "Смерть",
      place: person.deathPlace || undefined,
      kind: "death",
    });
  else if (estimate)
    items.push({
      id: `${person.id}:estimated-death`,
      year: estimate.year,
      date: String(estimate.year),
      title: "Предположительная смерть",
      kind: "death",
      estimated: true,
      description: `Оценка по архиву: средняя продолжительность жизни ${person.sex === "f" ? "женщин" : "мужчин"} за последние 100 лет — ${estimate.averageYears.toLocaleString("ru-RU")} лет (${estimate.sampleSize} ${plural(estimate.sampleSize, "запись", "записи", "записей")}) + 10 лет. Учтены известные даты и текущий год. Это расчётная отметка; дата смерти неизвестна.`,
    });
  const born = person.birth ? dateYear(person.birth) : null;
  for (const item of items) {
    if (born === null || item.year === null || item.kind === "birth") continue;
    const years = item.year - born;
    if (years < 0) continue;
    item.age = `≈ ${years} лет`;
  }
  return items;
}

function personStatus(person: Person, currentYear: number): string {
  if (hasRecordedDeath(person)) {
    const status =
      person.sex === "f"
        ? "Умерла"
        : person.sex === "m"
          ? "Умер"
          : "Смерть отмечена";
    const age = ageLabel(person);
    return person.death
      ? `${status}${age ? ` · ${age}` : ""}`
      : `${status} · дата неизвестна`;
  }
  if (!person.birth) return "Даты жизни неизвестны";
  const years = currentYear - dateYear(person.birth);
  return years >= 0 && years <= 110
    ? `Нет записи о смерти · сейчас ${ageLabel(person)}`
    : "Нет записи о смерти";
}

export function horizontalTimeline(
  people: Person[],
  reverse = false,
  currentYear = new Date().getFullYear(),
) {
  const averages = averageAdultLifespansBySex(people, currentYear);
  const childBirths = new Map<string, number>();
  for (const child of people)
    if (validDate(child.birth))
      for (const parent of child.parents)
        childBirths.set(parent, Math.max(childBirths.get(parent) ?? 0, dateYear(child.birth)));
  const prepared = people
    .filter((person) => validDate(person.birth))
    .map((person) => {
      const estimate = estimatedDeath(person, currentYear, averages, childBirths.get(person.id));
      return { person, estimate, items: personItems(person, estimate) };
    });
  let earliest = currentYear - 100,
    latest = currentYear + 20;
  for (const { items } of prepared)
    for (const item of items) {
      if (item.year === null) continue;
      earliest = Math.min(earliest, item.year);
      latest = Math.max(latest, item.year);
    }
  const start = Math.floor((earliest - 5) / 10) * 10;
  const end = latest;
  const width = (end - start) * YEAR_WIDTH;
  const yearX = (year: number) =>
    (reverse ? end - year : year - start) * YEAR_WIDTH;
  const yearAtX = (x: number) =>
    Math.max(
      start,
      Math.min(
        end,
        Math.round(reverse ? end - x / YEAR_WIDTH : start + x / YEAR_WIDTH),
      ),
    );
  const rows: TimelineRow[] = prepared
    .sort((a, b) => {
      const ay = a.person.birth ? dateYear(a.person.birth) : Infinity;
      const by = b.person.birth ? dateYear(b.person.birth) : Infinity;
      return (
        (reverse ? by - ay : ay - by) ||
        a.person.surname.localeCompare(b.person.surname, "ru") ||
        a.person.name.localeCompare(b.person.name, "ru")
      );
    })
    .map(({ person, items, estimate }) => {
      const byYear = new Map<number, TimelineItem[]>();
      const undated: TimelineItem[] = [];
      for (const item of items) {
        if (item.year === null) undated.push(item);
        else {
          const group = byYear.get(item.year);
          if (group) group.push(item);
          else byYear.set(item.year, [item]);
        }
      }
      const laneEnds: number[] = [];
      const groups = [...byYear]
        .sort((a, b) => (reverse ? b[0] - a[0] : a[0] - b[0]))
        .map(([year, events]) => {
          const x = yearX(year);
          let lane = laneEnds.findIndex((last) => last + EVENT_GAP <= x);
          if (lane < 0) lane = laneEnds.length;
          laneEnds[lane] = x + EVENT_WIDTH;
          return { year, items: events, x, lane };
        });
      return {
        person,
        status: personStatus(person, currentYear),
        groups,
        undated,
        height: Math.max(142, 80 + laneEnds.length * EVENT_LANE_HEIGHT),
        birthYear: person.birth ? dateYear(person.birth) : null,
        deathYear: validDate(person.death) ? dateYear(person.death) : null,
        ...(estimate ? { estimatedDeath: estimate } : {}),
      };
    });
  const eras = ERAS.filter((era) => era.end > start && era.start < end).map(
    (era) => {
      const first = Math.max(start, era.start);
      const last = Math.min(end, era.end);
      return {
        ...era,
        x: Math.min(yearX(first), yearX(last)),
        width: Math.abs(yearX(last) - yearX(first)),
      };
    },
  );
  const ticks = Array.from(
    { length: Math.floor((end - start) / 10) + 1 },
    (_, index) => start + index * 10,
  ).map((year) => ({ year, x: yearX(year) }));
  return {
    currentYear,
    start,
    end,
    width,
    yearX,
    yearAtX,
    rows,
    eras,
    ticks,
  };
}
