import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importGedcom } from "../src/domain/gedcom.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agelong-control");

test("the fictional GEDCOM 5.5.1 control carries the external roundtrip checklist", async () => {
  const text = await readFile(join(fixture, "control.ged"), "utf8");
  const imported = importGedcom(text, "external-control");
  const mother = imported.family.people.find((person) => person.name === "Анна");
  const child = imported.family.people.find((person) => person.name === "Лина");
  assert.equal(imported.family.people.length, 3);
  assert.equal(mother?.surname, "Петрова");
  assert.equal(mother?.maidenName, "Иванова");
  assert.equal(mother?.birth, "1901-05");
  assert.deepEqual(mother?.birthLocation, { place: "Тверь", lat: 56.85, lon: 35.91 });
  assert.equal(child?.parents.length, 2);
  assert.equal(imported.family.unions?.length, 1);
  assert.equal(imported.family.unions?.[0].formation?.date, "1928");
  assert.deepEqual(mother?.sources.map(({ title, reference, url, note }) =>
    ({ title, reference, url, note })), [{
    title: "Synthetic register", reference: "leaf 7",
    url: "https://example.org/synthetic/register", note: "Synthetic source comment",
  }]);
  assert.equal(imported.citationMedia?.[0].page, 7);
  assert.deepEqual(imported.media.map((item) => item.file).sort(),
    ["media/portrait.png", "media/record.pdf"]);
  assert.ok((await readFile(join(fixture, "media", "portrait.png"))).subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.match((await readFile(join(fixture, "media", "record.pdf"))).subarray(0, 8).toString(), /^%PDF-/);
});
