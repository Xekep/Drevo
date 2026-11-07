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
