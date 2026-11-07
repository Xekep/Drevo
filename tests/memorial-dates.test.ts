import assert from "node:assert/strict";
import test from "node:test";
import {
  upcomingMemorialDates,
  memorialDateLabel,
  type MemorialPerson,
} from "../src/domain/memorial-dates.ts";
import { memorialToday } from "../src/server/memorial-dates.ts";

const person = (
  id: string,
  death?: string,
  extra: Partial<MemorialPerson> = {},
): MemorialPerson => ({
  id,
  name: id,
  surname: "",
  patronymic: "",
  death,
  ...extra,
});

test("memorial window includes today and day seven, and crosses New Year without fabricating dates", () => {
  const result = upcomingMemorialDates(
    [
      person("today", "2000-12-29"),
      person("next-year", "2001-01-05"),
      person("too-late", "2000-01-06"),
      person("partial", "2000-01"),
      person("year", "2000"),
      person("unknown"),
      person("invalid", "2000-02-30"),
      person("future", "2030-01-01"),
      person("this-year", "2026-12-30"),
      person("julian-partial", "1900-12-30", { deathJulian: "1900-12" }),
    ],
    "2026-12-29",
  );
  assert.deepEqual(
    result.map((p) => [p.personId, p.date, p.years, p.days]),
    [
      ["today", "2026-12-29", 26, 0],
      ["next-year", "2027-01-05", 26, 7],
    ],
  );
  assert.equal(memorialDateLabel(result[0]), "Сегодня — 26 лет со дня смерти");
  assert.equal(
    memorialDateLabel(result[1]),
    "05.01.2027 — 26 лет со дня смерти",
  );
  assert.throws(() => upcomingMemorialDates([], "2026"));
});

test("February 29 is observed on February 28 in common years, and remains February 29 in leap years", () => {
  const people = [person("leap", "2000-02-29")];
  assert.deepEqual(
    upcomingMemorialDates(people, "2027-02-28").map((p) => [p.date, p.years]),
    [["2027-02-28", 27]],
  );
  assert.deepEqual(
    upcomingMemorialDates(people, "2028-02-28").map((p) => [p.date, p.days]),
    [["2028-02-29", 1]],
  );
  assert.deepEqual(upcomingMemorialDates(people, "2027-03-01"), []);
});

test("full recorded Gregorian equivalents of Julian dates are used, with stable yearly identities", () => {
  const people = [
    person("old-style", "1908-11-19", { deathJulian: "1908-11-06", name: "" }),
  ];
  const first = upcomingMemorialDates(people, "2026-11-12")[0];
  const same = upcomingMemorialDates(people, "2026-11-19")[0];
  const next = upcomingMemorialDates(people, "2027-11-19")[0];
  assert.equal(first.personName, "Имя неизвестно");
  assert.equal(first.id, same.id);
  assert.notEqual(first.id, next.id);
});

test("today follows the requested time zone around midnight", () => {
  const now = new Date("2026-11-07T22:00:00Z");
  assert.equal(memorialToday("Europe/Moscow", now), "2026-11-08");
  assert.equal(memorialToday("America/New_York", now), "2026-11-07");
  assert.throws(() => memorialToday("invalid/time-zone", now));
});

test("living birthdays share the window, keep chronological order and calculate upcoming age", () => {
  const result = upcomingMemorialDates(
    [
      person("today-birthday", undefined, { birth: "1991-12-29" }),
      person("next-year-birthday", undefined, { birth: "1991-01-05" }),
      person("memorial", "2000-12-31", { birth: "1980-12-30" }),
      person("outside", undefined, { birth: "1991-01-06" }),
    ],
    "2026-12-29",
  );
  assert.deepEqual(
    result.map((p) => [p.personId, p.kind, p.date, p.years]),
    [
      ["today-birthday", "birthday", "2026-12-29", 35],
      ["memorial", "death_anniversary", "2026-12-31", 26],
      ["next-year-birthday", "birthday", "2027-01-05", 36],
    ],
  );
  assert.equal(
    memorialDateLabel(result[0]),
    "Сегодня — день рождения, исполнилось 35 лет",
  );
  assert.equal(
    memorialDateLabel(result[2]),
    "05.01.2027 — день рождения, исполнится 36 лет",
  );
});

test("all recorded death indicators suppress birthdays, including unknown death dates", () => {
  const birth = "1991-11-07";
  const result = upcomingMemorialDates(
    [
      person("marked", undefined, { birth, deceased: true }),
      person("place-only", undefined, { birth, deathPlace: "Казань" }),
      person("death-year", "2020", { birth }),
      person("death-month", "2020-05", { birth }),
      person("death-day", "2020-05-09", { birth }),
      person("living", undefined, { birth, deceased: false }),
    ],
    "2026-11-07",
  );
  assert.deepEqual(
    result.map((p) => p.personId),
    ["living"],
  );
});

test("birthday reminders need full dates and exclude future births and historical unknown-status cards", () => {
  assert.deepEqual(
    upcomingMemorialDates(
      [
        person("partial", undefined, { birth: "1991-11" }),
        person("year", undefined, { birth: "1991" }),
        person("invalid", undefined, { birth: "1991-02-30" }),
        person("unknown", undefined, { birth: "" }),
        person("future", undefined, { birth: "2030-11-07" }),
        person("newborn", undefined, { birth: "2026-11-07" }),
        person("historic", undefined, { birth: "1800-11-07" }),
        person("julian-period", undefined, {
          birth: "1991-11-07",
          birthJulian: "1991-11",
        }),
      ],
      "2026-11-07",
    ),
    [],
  );
  const people = [person("boundary", undefined, { birth: "1906-11-07" })];
  assert.equal(upcomingMemorialDates(people, "2026-11-07")[0].years, 120);
  assert.deepEqual(upcomingMemorialDates(people, "2027-11-07"), []);
});

test("leap-day birthdays and full Julian pairs follow the same explicit calendar policy", () => {
  const leap = [person("leap", undefined, { birth: "2000-02-29" })];
  assert.equal(upcomingMemorialDates(leap, "2027-02-28")[0].date, "2027-02-28");
  assert.equal(upcomingMemorialDates(leap, "2028-02-28")[0].date, "2028-02-29");
  const old = [
    person("old-style", undefined, {
      birth: "1991-11-19",
      birthJulian: "1991-11-06",
    }),
  ];
  assert.equal(upcomingMemorialDates(old, "2026-11-12")[0].date, "2026-11-19");
  assert.equal(
    upcomingMemorialDates(old, "2026-11-12")[0].id,
    upcomingMemorialDates(old, "2026-11-19")[0].id,
  );
});
