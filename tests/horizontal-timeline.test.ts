import test from "node:test";
import assert from "node:assert/strict";
import {
  horizontalTimeline,
  timelineRowsAtYear,
} from "../src/domain/horizontal-timeline.ts";
import type { Person } from "../src/domain/types.ts";

function person(
  id: string,
  birth: string,
  extras: Partial<Person> = {},
): Person {
  return {
    id,
    surname: "Тестов",
    name: id,
    patronymic: "",
    sex: "m",
    birth,
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
    ...extras,
  };
}

test("timeline groups same-year events and gives overlapping cards separate lanes", () => {
  const model = horizontalTimeline(
    [
      person("ivan", "1940-05-01", {
        death: "2020-03-01",
        events: [
          { id: "work", type: "work", date: "1960-06-01", place: "Москва" },
          { id: "marriage", type: "marriage", date: "1960-07-01" },
          { id: "move", type: "move", date: "1961-01-01" },
          { id: "unknown", type: "education", dateText: "около 1950 года" },
        ],
        awards: [{ id: "award", name: "Награда", year: "1961" }],
      }),
    ],
    false,
    2026,
  );
  const row = model.rows[0];
  assert.equal(
    row.groups.find((group) => group.year === 1960)?.items.length,
    2,
  );
  assert.equal(
    row.groups.find((group) => group.year === 1961)?.items.length,
    2,
  );
  assert.equal(
    row.undated.length,
    1,
    "approximate dates are not silently made exact",
  );
  assert.notEqual(row.groups[1].lane, row.groups[2].lane);
  assert.ok(row.height >= 202, "all lanes fit inside the person's row");
  assert.match(row.status, /Умер ·/);
  assert.equal(
    row.groups.find((group) => group.year === 1960)?.items[0].age,
    "≈ 20 лет",
  );
});

test("reverse chronology mirrors event and era positions without changing dates", () => {
  const people = [person("older", "1880"), person("younger", "1990")];
  const forward = horizontalTimeline(people, false, 2026);
  const reverse = horizontalTimeline(people, true, 2026);
  assert.deepEqual(
    forward.rows.map((row) => row.person.id),
    ["older", "younger"],
  );
  assert.deepEqual(
    reverse.rows.map((row) => row.person.id),
    ["younger", "older"],
  );
  assert.equal(forward.yearX(1880) + reverse.yearX(1880), forward.width);
  assert.ok(forward.eras.some((era) => era.name === "Российская империя"));
  assert.ok(forward.eras.some((era) => era.name === "Советский Союз"));
  assert.ok(forward.eras.some((era) => era.name === "Россия"));
  assert.match(forward.rows[0].status, /Нет записи о смерти/);
  assert.doesNotMatch(forward.rows[0].status, /сейчас/);
  assert.equal(forward.yearAtX(forward.yearX(1880)), 1880);
  assert.equal(forward.yearAtX(forward.yearX(1990)), 1990);
});

test("chronology excludes people without a birth date even when they have dated events", () => {
  const model = horizontalTimeline(
    [
      person("dated", "1900"),
      person("unknown", "", {
        events: [{ id: "event", type: "work", date: "1950" }],
      }),
    ],
    false,
    2026,
  );
  assert.deepEqual(
    model.rows.map((row) => row.person.id),
    ["dated"],
  );
  assert.ok(model.yearX(1900) < model.yearX(2026));
});

test("chronology extends twenty years ahead and keeps later recorded events", () => {
  const current = horizontalTimeline([person("dated", "1940")], false, 2026);
  assert.equal(current.end, 2046);
  assert.equal(current.currentYear, 2026);
  assert.equal(current.ticks.at(-1)?.year, 2040);
  assert.equal(current.yearAtX(current.width), 2046);

  const future = horizontalTimeline(
    [
      person("dated", "1940", {
        events: [{ id: "future", type: "work", date: "2032" }],
      }),
    ],
    false,
    2026,
  );
  assert.equal(future.end, 2046);
  assert.equal(future.yearAtX(future.width), 2046);
  const later = horizontalTimeline([person("later", "2000", {
    events: [{ id: "later-event", type: "work", date: "2060" }],
  })], false, 2026);
  assert.equal(later.end, 2060);
});

test("historical year reveals births and removes people only after a recorded death", () => {
  const rows = horizontalTimeline(
    [
      person("older", "1880"),
      person("dated", "1900", { death: "1950" }),
      person("later", "1960"),
    ],
    false,
    2026,
  ).rows;
  const ids = (year: number) =>
    timelineRowsAtYear(rows, year).map((row) => row.person.id);
  assert.deepEqual(ids(1899), ["older"]);
  assert.deepEqual(ids(1900), ["older", "dated"]);
  assert.deepEqual(ids(1950), ["older", "dated"]);
  assert.deepEqual(ids(1951), ["older"]);
  assert.deepEqual(ids(1960), ["older", "later"]);
});

test("dense chronology preserves bounds and same-year event order beyond the argument limit", () => {
  const events: NonNullable<Person["events"]> = Array.from(
    { length: 150 },
    (_, index) => ({
      id: `event-${index}`,
      type: "work",
      date: index === 0 ? "1880" : index === 149 ? "2032" : "1950",
    }),
  );
  for (const event of events) Object.freeze(event);
  Object.freeze(events);
  const people = Array.from({ length: 1000 }, (_, index) =>
    person(`dense-${index}`, "1900", { events }),
  );
  for (const item of people) Object.freeze(item);
  const model = horizontalTimeline(people, false, 2026);
  assert.equal(model.start, 1870);
  assert.equal(model.end, 2046);
  assert.equal(model.rows.length, 1000);
  assert.ok(Number.isFinite(model.width));
  for (const row of model.rows) {
    const grouped = row.groups.find((group) => group.year === 1950)!;
    assert.equal(grouped.items.length, 148);
    assert.equal(grouped.items[0].id, `${row.person.id}:event:event-1`);
    assert.equal(grouped.items.at(-1)!.id, `${row.person.id}:event:event-148`);
    assert.equal(row.person.events, events);
  }
});

test("marked deaths without dates use the recorded adult average for their own sex only", () => {
  const people = [
    person("male-sixty", "1900", { death: "1960" }),
    person("male-eighty", "1900", { death: "1980" }),
    person("female-ninety", "1900", { sex: "f", death: "1990" }),
    person("estimated-male", "1850", { deceased: true }),
    person("estimated-female", "1880", { sex: "f", deceased: true }),
    person("unknown-sex", "1850", { sex: "u", deceased: true }),
    person("living", "1850"),
    person("young-deceased", "2000", { deceased: true }),
  ];
  const before = structuredClone(people);
  const model = horizontalTimeline(people, false, 2026);
  const row = (id: string) => model.rows.find((item) => item.person.id === id)!;
  assert.deepEqual(row("estimated-male").estimatedDeath,
    { year: 1930, averageYears: 70, sampleSize: 2 });
  assert.deepEqual(row("estimated-female").estimatedDeath,
    { year: 1980, averageYears: 90, sampleSize: 1 });
  assert.equal(row("estimated-male").deathYear, null, "the estimate is not a recorded death");
  const item = row("estimated-male").groups.find((group) => group.year === 1930)?.items[0];
  assert.equal(item?.title, "Предположительная смерть");
  assert.equal(item?.estimated, true);
  assert.match(item?.description || "", /100 лет.*70 лет.*2 записи.*10 лет.*расчётная отметка/);
  assert.equal(row("unknown-sex").estimatedDeath, undefined);
  assert.equal(row("living").estimatedDeath, undefined);
  assert.equal(row("young-deceased").estimatedDeath?.year, 2026,
    "a person already marked deceased cannot receive a future death estimate");
  const ids = (year: number) => timelineRowsAtYear(model.rows, year, model.currentYear)
    .map((item) => item.person.id);
  assert.ok(ids(1930).includes("estimated-male"));
  assert.ok(!ids(1931).includes("estimated-male"));
  assert.ok(ids(1979).includes("estimated-female"));
  assert.ok(!ids(1981).includes("estimated-female"));
  assert.ok(!ids(2026).includes("unknown-sex"));
  assert.deepEqual(ids(2046), ["living"]);
  assert.deepEqual(people, before, "display estimates never mutate archive dates or events");
});

test("death estimates respect life events and burial, but not posthumous awards", () => {
  const model = horizontalTimeline([
    person("sample", "1900", { death: "1960" }),
    person("work", "1850", { deceased: true,
      events: [{ id: "work", type: "work", date: "1935", endDate: "1940" }] }),
    person("burial", "1850", { deceased: true,
      events: [{ id: "burial", type: "burial", date: "1900" }] }),
    person("award", "1850", { deceased: true,
      awards: [{ id: "award", name: "Посмертная награда", year: "2000" }] }),
    person("contradictory", "1850", { deceased: true,
      events: [
        { id: "work", type: "work", date: "1940" },
        { id: "burial", type: "burial", date: "1900" },
      ] }),
    person("father", "1850", { deceased: true }),
    person("daughter", "1945", { parents: ["father"] }),
  ], false, 2026);
  const estimate = (id: string) => model.rows.find((row) => row.person.id === id)?.estimatedDeath;
  assert.equal(estimate("work")?.year, 1940);
  assert.equal(estimate("burial")?.year, 1900);
  assert.equal(estimate("award")?.year, 1920);
  assert.equal(estimate("contradictory"), undefined);
  assert.equal(estimate("father")?.year, 1944,
    "a later recorded child's birth constrains the father's estimate, allowing a posthumous birth");
});

test("missing lifespan samples never produce a death year or keep known deceased people in the future", () => {
  const model = horizontalTimeline([
    person("no-sample", "1900", { deceased: true }),
    person("death-place", "1900", { deathPlace: "Москва" }),
    person("no-birth", "", { deceased: true }),
    person("invalid-birth", "unknown", { deceased: true }),
    person("living", "1900"),
  ], false, 2026);
  assert.equal(model.rows.length, 3);
  assert.ok(model.rows.every((row) => row.estimatedDeath === undefined));
  assert.equal(timelineRowsAtYear(model.rows, 1950, model.currentYear).length, 3);
  assert.deepEqual(timelineRowsAtYear(model.rows, 2046, model.currentYear)
    .map((row) => row.person.id), ["living"]);
});
