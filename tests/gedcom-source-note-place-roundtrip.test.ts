import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { Family } from "../src/domain/types.ts";

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} retains a source comment identical to its URL note with place coordinates`, () => {
    const url = "https://archive.example/scan/7";
    const family: Family = {
      title: "Семейный архив", description: "", demo: false, photos: [],
      people: [{
        id: "p1", surname: "Иванова", name: "Анна", patronymic: "", sex: "f",
        birth: "1900", birthPlace: "Тверь",
        birthLocation: { place: "Тверь", lat: 56.85, lon: 35.91 },
        parents: [], spouses: [], generation: 1, column: 0,
        sources: [{ title: "Метрическая книга", type: "архив", reference: "л. 7",
          url, note: `URL: ${url}` }],
        events: [{ id: "residence", type: "residence", place: "Суздаль",
          location: { place: "Суздаль", lat: 56.42, lon: 40.45 } }],
      }],
    };
    const exported = exportGedcom(family, { version });
    const sourceRecord = exported.split("0 @S1@ SOUR\r\n")[1].split("\r\n0 ")[0];
    assert.equal(sourceRecord.match(new RegExp(`1 NOTE URL: ${url}`, "g"))?.length, 2);
    // A receiving program may ignore Drevo's private fields and retain only
    // the standard SOURCE_RECORD notes and PLAC.MAP coordinates.
    const standard = exported
      .replace(/^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm, "")
      .replace(/^1 _URL .*\r?\n/gm, "");
    const person = importGedcom(standard, `source-place-${version}`).family.people[0];
    assert.equal(person.sources[0].url, url);
    assert.equal(person.sources[0].note, `URL: ${url}`);
    assert.deepEqual(person.birthLocation, family.people[0].birthLocation);
    assert.deepEqual(person.events?.find((event) => event.type === "residence")?.location,
      family.people[0].events?.[0].location);
  });
