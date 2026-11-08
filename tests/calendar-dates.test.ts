import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLifeDate,
  julianToGregorian,
  validCalendarPair,
  canUseOldStyleDate,
  canUseByzantineDate,
  normalizeByzantineDate,
  validByzantinePair,
} from "../src/domain/calendar-dates.ts";
import { validDate } from "../src/domain/dates.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { rebasePersonDraft } from "../src/domain/person-draft.ts";
import type { Family } from "../src/domain/types.ts";

test("old-style control is offered only for dates before the Russian February 1918 transition", () => {
  for (const date of ["1900", "02.1900", "29.2.1900", "1917-10-25", "1918", "01.1918", "31.01.1918"])
    assert.equal(canUseOldStyleDate(date), true, date);
  for (const date of ["", "01.02.1918", "02.1918", "14.02.1918", "03.1918", "1919", "2000", "29.2.2000", "12.11.2026", "nonsense"])
    assert.equal(canUseOldStyleDate(date), false, date);
});

test("event old-style dates round-trip through GEDCOM and are validated as pairs", () => {
  const event = {
    id: "old-record",
    type: "baptism" as const,
    date: "1900-03-13",
    dateJulian: "1900-02-29",
  };
  const archive: Family = {
    title: "Календарь событий",
    description: "",
    demo: false,
    people: [{
      id: "child", surname: "Тестов", name: "Павел", patronymic: "",
      sex: "m" as const, birth: "1899", birthPlace: "", parents: [], spouses: [],
      generation: 1, column: 0, sources: [], events: [event],
    }],
  };
  assert.doesNotThrow(() => validateFamily(archive));
  const text = exportGedcom(archive, { version: "7.0" });
  assert.match(text, /DATE JULIAN 29 FEB 1900/);
  const restored = importGedcom(text, "calendar-event").family.people[0].events;
  assert.ok(restored?.some(record => record.date === event.date && record.dateJulian === event.dateJulian));
  const corrupted: Family = { ...archive, people: archive.people.map(person => ({
    ...person, events: [{ ...event, date: "1900-03-14" }],
  })) };
  assert.throws(() => validateFamily(corrupted), /старому стилю/);
});

test("Byzantine September year is an explicit era, not Julian style", () => {
  assert.equal(canUseByzantineDate("12.12.7159"), true);
  assert.equal(canUseByzantineDate("1650"), false);
  assert.deepEqual(normalizeByzantineDate("12.12.7159"), {
    date: "1650-12-22",
    julian: "1650-12-12",
    byzantine: "7159-12-12",
  });
  assert.deepEqual(normalizeByzantineDate("01.01.7159"), {
    date: "1651-01-11",
    julian: "1651-01-01",
    byzantine: "7159-01-01",
  });
  assert.throws(() => normalizeByzantineDate("7159"), /Укажите месяц/);
  assert.equal(validByzantinePair("1650-12-22", "1650-12-12", "7159-12-12"), true);
  assert.equal(validByzantinePair("1651-12-22", "1650-12-12", "7159-12-12"), false);
});

test("Byzantine birth and event preserve their era through GEDCOM", () => {
  const birth = normalizeByzantineDate("12.12.7159");
  const family: Family = {
    title: "Византийская эра", description: "", demo: false,
    people: [{
      id: "b", surname: "Тестов", name: "Павел", patronymic: "", sex: "m",
      birth: birth.date, birthJulian: birth.julian, birthByzantine: birth.byzantine,
      birthPlace: "", sources: [], parents: [], spouses: [], generation: 1, column: 0,
      events: [{
        id: "bapt", type: "baptism", date: birth.date, dateJulian: birth.julian,
        dateByzantine: birth.byzantine,
      }],
    }],
  };
  assert.doesNotThrow(() => validateFamily(family));
  const gedcom = exportGedcom(family, { version: "7.0" });
  assert.match(gedcom, /_DREVO_BYZANTINE_DATE 7159-12-12/);
  assert.match(gedcom, /DATE JULIAN 12 DEC 1650/);
  const imported = importGedcom(gedcom, "byzantine-test").family.people[0];
  assert.equal(imported.birthByzantine, birth.byzantine);
  assert.equal(imported.events?.find(x => x.type === "baptism")?.dateByzantine, birth.byzantine);
  assert.doesNotThrow(() => validateFamily({ ...family, people: [imported] }));
});

test("Julian conversion follows century leap boundaries rather than a constant offset", () => {
  for (const [old, modern] of [
    ["1582-10-04", "1582-10-14"],
    ["1700-02-28", "1700-03-10"],
    ["1700-02-29", "1700-03-11"],
    ["1800-03-01", "1800-03-13"],
    ["1900-02-28", "1900-03-12"],
    ["1900-02-29", "1900-03-13"],
    ["1900-03-01", "1900-03-14"],
    ["1917-10-25", "1917-11-07"],
    ["1900-12-25", "1901-01-07"],
    ["2000-02-29", "2000-03-13"],
  ])
    assert.equal(julianToGregorian(old), modern);
  assert.equal(validDate("1900-02-29"), false);
  assert.equal(validDate("1900-02-29", "julian"), true);
  assert.throws(() => julianToGregorian("1901-02-29"));
  assert.throws(() => julianToGregorian("9999-12-31"));
});
test("partial dates keep their precision; mismatched canonical dates are rejected", () => {
  assert.deepEqual(normalizeLifeDate("29.2.1900", true), {
    date: "1900-03-13",
    julian: "1900-02-29",
  });
  assert.deepEqual(normalizeLifeDate("02.1900", true), {
    date: "1900-02",
    julian: "1900-02",
  });
  assert.deepEqual(normalizeLifeDate("1900", true), {
    date: "1900",
    julian: "1900",
  });
  assert.deepEqual(normalizeLifeDate("", true), {
    date: "",
    julian: undefined,
  });
  assert.equal(validCalendarPair("1900-03-13", "1900-02-29"), true);
  assert.equal(validCalendarPair("1900-03-14", "1900-02-29"), false);
  assert.equal(validCalendarPair("1900", {}), false);
});
const family: Family = {
  title: "Календарь",
  description: "",
  demo: false,
  people: [
    {
      id: "p",
      name: "Иван",
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: "1900-03-13",
      birthJulian: "1900-02-29",
      death: "1980-01-01",
      deathJulian: "1979-12-19",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
    },
  ],
};
for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} retains a Julian birth without relying on Drevo extensions`, () => {
    const text = exportGedcom(family, { version })
      .split("\n")
      .filter((line) => !line.includes("_DREVO "))
      .join("\n");
    assert.match(
      text,
      version === "7.0"
        ? /DATE JULIAN 29 FEB 1900/
        : /DATE @#DJULIAN@ 29 FEB 1900/,
    );
    const restored = importGedcom(text, "calendar").family.people[0];
    assert.equal(restored.birth, "1900-03-13");
    assert.equal(restored.birthJulian, "1900-02-29");
    assert.equal(restored.death, "1980-01-01");
    assert.equal(restored.deathJulian, "1979-12-19");
    assert.doesNotThrow(() =>
      validateFamily({ ...family, people: [restored] }),
    );
    const second = importGedcom(
      exportGedcom({ ...family, people: [restored] }, { version }),
      "second",
    ).family.people[0];
    assert.equal(second.birthJulian, restored.birthJulian);
    assert.equal(second.deathJulian, restored.deathJulian);
  });
test("server validation and concurrent edits preserve the date/calendar pair", () => {
  const p = family.people[0];
  assert.throws(
    () =>
      validateFamily({ ...family, people: [{ ...p, birth: "1900-03-14" }] }),
    /старому стилю/,
  );
  const changed = { ...p, birth: "1900-03-14", birthJulian: "1900-03-01" };
  const fresh = { ...p, birth: "1900-03-15", birthJulian: "1900-03-02" };
  assert.throws(
    () => rebasePersonDraft(p, fresh, changed),
    /календарь изменились/,
  );
  assert.deepEqual(rebasePersonDraft(p, fresh, { ...p, name: "Пётр" }), {
    ...fresh,
    name: "Пётр",
  });
});
