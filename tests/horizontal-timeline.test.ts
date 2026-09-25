import test from "node:test";
import assert from "node:assert/strict";
import { horizontalTimeline } from "../src/domain/horizontal-timeline.ts";
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
