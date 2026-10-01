import { ageLabel, dateYear, hasRecordedDeath } from "./dates.ts";
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
};

/** Only a recorded death removes a person from a historical year. */
export function timelineRowsAtYear(
  rows: readonly TimelineRow[],
  year: number,
): TimelineRow[] {
  return rows.filter(
    (row) =>
      row.birthYear !== null &&
      row.birthYear <= year &&
      (row.deathYear === null || row.deathYear >= year),
  );
}

function personItems(person: Person): TimelineItem[] {
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
      year: event.date ? dateYear(event.date) : null,
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
      year: dateYear(person.death),
      date: person.death,
      title: "Смерть",
      place: person.deathPlace || undefined,
      kind: "death",
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
  const prepared = people
    .filter((person) => !!person.birth)
    .map((person) => ({
      person,
      items: personItems(person),
    }));
  const datedYears = prepared.flatMap(({ items }) =>
    items.flatMap((item) => (item.year === null ? [] : [item.year])),
  );
  const start =
    Math.floor((Math.min(currentYear - 100, ...datedYears) - 5) / 10) * 10;
  const end = Math.max(currentYear, ...datedYears);
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
    .map(({ person, items }) => {
      const byYear = new Map<number, TimelineItem[]>();
      const undated: TimelineItem[] = [];
      for (const item of items) {
        if (item.year === null) undated.push(item);
        else byYear.set(item.year, [...(byYear.get(item.year) || []), item]);
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
        deathYear: person.death ? dateYear(person.death) : null,
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
