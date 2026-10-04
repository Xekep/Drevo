import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

const place = ", Oneida, Idaho, USA";
const defaultForm = "City, County, State, Country";
const localForm = "Town, County, State, Country";

function sample(version: "5.5.1" | "7.0") {
  return [
    "0 HEAD", "1 SOUR TEST", "1 GEDC", `2 VERS ${version}`,
    ...(version === "5.5.1" ? ["2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"] : []),
    "1 PLAC", `2 FORM ${defaultForm}`,
    "0 @I1@ INDI", "1 NAME Alex /Example/",
    "1 BIRT Y", "2 DATE 1900", `2 PLAC ${place}`,
    "3 MAP", "4 LATI N42", "4 LONG W116",
    "2 SOUR @S1@", "3 PAGE 4",
    "1 DEAT Y", "2 DATE 1980", `2 PLAC ${place}`, `3 FORM ${localForm}`,
    "1 RESI", "2 DATE 1920", `2 PLAC ${place}`, `3 FORM ${localForm}`,
    "0 @S1@ SOUR", "1 TITL Register", "1 DATA", "2 EVEN BIRT",
    `3 PLAC ${place}`, `4 FORM ${localForm}`,
    "0 TRLR",
  ].join("\n");
}

for (const version of ["5.5.1", "7.0"] as const) {
  test(`GEDCOM ${version} retains local and HEAD place hierarchy next to each place`, () => {
    const imported = importGedcom(sample(version), `form-${version}`);
    const person = imported.family.people[0];
    assert.equal(person.birthPlace, place);
    assert.deepEqual(person.birthLocation, { place, lat: 42, lon: -116 });
    const birth = person.events?.find((event) => event.gedcomTag === "BIRT");
    const death = person.events?.find((event) => event.gedcomTag === "DEAT");
    assert.match(birth?.description || "", new RegExp(`HEAD\\.PLAC\\.FORM: ${defaultForm}`));
    assert.match(death?.description || "", new RegExp(`PLAC\\.FORM: ${localForm}`));
    assert.doesNotMatch(death?.description || "", new RegExp(`HEAD\\.PLAC\\.FORM: ${localForm}`));
    const residence = person.events?.find((event) => event.gedcomTag === "RESI");
    assert.match(residence?.description || "", new RegExp(`PLAC\\.FORM: ${localForm}`));
    assert.equal(residence?.place, place);
    assert.match(person.sources[0].note || "", new RegExp(`SOUR\\.DATA\\.EVEN\\.PLAC`));
    assert.match(person.sources[0].note || "", new RegExp(localForm));
    assert.equal(person.sources[0].reference, "4");
    assert.ok(imported.warnings.some((warning) => /PLAC\.FORM/.test(warning)));

    const again = importGedcom(exportGedcom(imported.family, { version }), `again-${version}`);
    assert.equal(again.family.people[0].biography, person.biography);
    assert.deepEqual(again.family.people[0].birthLocation, person.birthLocation);
    assert.equal(again.family.people[0].sources[0].reference, "4");
    assert.equal(again.family.people[0].events?.find((event) =>
      event.gedcomTag === "BIRT")?.description, birth?.description);
    assert.equal(again.family.people[0].events?.find((event) =>
      event.gedcomTag === "DEAT")?.description, death?.description);
    assert.equal(again.family.people[0].sources[0].note, person.sources[0].note);
    assert.equal(again.family.people[0].events?.find((event) =>
      event.gedcomTag === "RESI")?.description, residence?.description);
  });
}

test("HEAD.PLAC.FORM without a PLAC does not invent a place or event", () => {
  const input = ["0 HEAD", "1 GEDC", "2 VERS 7.0", "1 PLAC",
    `2 FORM ${defaultForm}`, "0 @I1@ INDI", "1 NAME Alex /Example/", "0 TRLR"].join("\n");
  const person = importGedcom(input, "unused-form").family.people[0];
  assert.equal(person.birthPlace, "");
  assert.equal(person.biography, undefined);
  assert.equal(person.events, undefined);
});

test("an empty local FORM does not silently apply the HEAD default", () => {
  const input = ["0 HEAD", "1 GEDC", "2 VERS 7.0", "1 PLAC",
    `2 FORM ${defaultForm}`, "0 @I1@ INDI", "1 NAME Alex /Example/",
    "1 BIRT Y", "2 DATE 1900", `2 PLAC ${place}`, "3 FORM", "0 TRLR"].join("\n");
  const imported = importGedcom(input, "empty-local-form");
  const birth = imported.family.people[0].events?.find((event) => event.gedcomTag === "BIRT");
  assert.equal(birth?.place, place);
  assert.doesNotMatch(birth?.description || "", /HEAD\.PLAC\.FORM/);
  assert.ok(imported.warnings.some((warning) => /Пустой локальный PLAC\.FORM/.test(warning)));
});

test("Drevo event metadata keeps a newly added place FORM once", () => {
  const initial = importGedcom(sample("7.0"), "metadata-form");
  const exported = exportGedcom(initial.family, { version: "7.0" });
  const modified = exported.replace(
    `2 PLAC ${place}\r\n2 NOTE`,
    `2 PLAC ${place}\r\n3 FORM Parish, County, State, Country\r\n2 NOTE`,
  );
  assert.notEqual(modified, exported);
  const imported = importGedcom(modified, "metadata-form-added");
  const event = imported.family.people[0].events?.find((item) => item.gedcomTag === "RESI");
  assert.match(event?.description || "", /Parish, County, State, Country/);
  const again = importGedcom(exportGedcom(imported.family, { version: "7.0" }), "metadata-form-again");
  const description = again.family.people[0].events?.find((item) => item.gedcomTag === "RESI")?.description || "";
  assert.equal((description.match(/Parish, County, State, Country/g) || []).length, 1);
});

test("changed event date does not hide a matching place FORM in Drevo metadata", () => {
  const initial = importGedcom(sample("7.0"), "metadata-date-form");
  const exported = exportGedcom(initial.family, { version: "7.0" });
  const changed = exported.replace(
    `1 BIRT\r\n2 TYPE Рождение\r\n2 DATE 1900\r\n2 PLAC ${place}`,
    `1 BIRT\r\n2 TYPE Рождение\r\n2 DATE ABT 1910\r\n2 PLAC ${place}\r\n3 FORM ${defaultForm}`,
  );
  assert.notEqual(changed, exported);
  const imported = importGedcom(changed, "metadata-date-form-added");
  const person = imported.family.people[0];
  assert.match(person.biography || "", /DATE ABT 1910/);
  assert.match(person.biography || "", new RegExp(defaultForm));
  assert.equal(person.events?.find((event) => event.gedcomTag === "BIRT")?.date, "1900");
  const again = importGedcom(exportGedcom(imported.family, { version: "7.0" }), "metadata-date-form-again");
  assert.equal(again.family.people[0].biography, person.biography);
});

test("Drevo source metadata retains an externally added source-event FORM once", () => {
  const input = ["0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI",
    "1 NAME Alex /Example/", "1 SOUR @S1@", "0 @S1@ SOUR",
    "1 TITL Register", "0 TRLR"].join("\n");
  const exported = exportGedcom(importGedcom(input, "source-form").family, { version: "7.0" });
  const modified = exported.replace("1 TITL Register\r\n0 TRLR",
    `1 TITL Register\r\n1 DATA\r\n2 EVEN BIRT\r\n3 PLAC ${place}\r\n4 FORM ${localForm}\r\n0 TRLR`);
  assert.notEqual(modified, exported);
  const first = importGedcom(modified, "source-form-added");
  assert.match(first.family.people[0].sources[0].note || "", /SOUR\.DATA\.EVEN\.PLAC; EVEN BIRT/);
  assert.match(first.family.people[0].sources[0].note || "", new RegExp(localForm));
  const second = importGedcom(exportGedcom(first.family, { version: "7.0" }), "source-form-again");
  assert.equal(second.family.people[0].sources[0].note, first.family.people[0].sources[0].note);
});

test("source-event FORM with a changed date is not mistaken for an old source note", () => {
  const input = ["0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI",
    "1 NAME Alex /Example/", "1 SOUR @S1@", "0 @S1@ SOUR",
    "1 TITL Register", "1 DATA", "2 EVEN BIRT", "3 DATE 1900",
    `3 PLAC ${place}`, `4 FORM ${localForm}`, "0 TRLR"].join("\n");
  const exported = exportGedcom(importGedcom(input, "source-date-form").family, { version: "7.0" });
  const changed = exported.replace("0 @S1@ SOUR\r\n1 TITL Register",
    `0 @S1@ SOUR\r\n1 TITL Register\r\n1 DATA\r\n2 EVEN BIRT\r\n3 DATE 1910\r\n3 PLAC ${place}\r\n4 FORM ${localForm}`);
  assert.notEqual(changed, exported);
  const imported = importGedcom(changed, "source-date-form-added");
  const note = imported.family.people[0].sources[0].note || "";
  assert.match(note, /SOUR\.DATA\.EVEN\.PLAC; EVEN BIRT; DATE 1900/);
  assert.match(note, /SOUR\.DATA\.EVEN\.PLAC; EVEN BIRT; DATE 1910/);
});

test("a family-event place FORM reaches both spouses without changing coordinates", () => {
  const input = ["0 HEAD", "1 GEDC", "2 VERS 7.0", "1 PLAC",
    `2 FORM ${defaultForm}`, "0 @I1@ INDI", "1 NAME Alex /Example/",
    "0 @I2@ INDI", "1 NAME Sam /Example/", "0 @F1@ FAM",
    "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR Y", "2 DATE 1900",
    `2 PLAC ${place}`, "3 MAP", "4 LATI N42", "4 LONG W116", "0 TRLR"].join("\n");
  const first = importGedcom(input, "marriage-form");
  assert.equal(first.family.unions?.[0].formation?.date, "1900");
  assert.equal(first.family.unions?.[0].formation?.place, place);
  for (const person of first.family.people) {
    const marriage = person.events?.find((event) => event.gedcomTag === "MARR");
    assert.match(marriage?.description || "", new RegExp(defaultForm));
    assert.deepEqual(marriage?.location, { place, lat: 42, lon: -116 });
  }
  const exported = exportGedcom(first.family, { version: "7.0" });
  const withEquivalentForm = exported.replace(
    `1 MARR Y\r\n2 DATE 1900\r\n2 PLAC ${place}`,
    `1 MARR Y\r\n2 DATE 1900\r\n2 PLAC ${place}\r\n3 FORM ${defaultForm}`,
  );
  assert.notEqual(withEquivalentForm, exported);
  const second = importGedcom(withEquivalentForm, "marriage-form-back");
  assert.equal(second.family.unions?.[0].formation?.date, "1900");
  assert.equal(second.family.unions?.[0].formation?.place, place);
  for (const person of second.family.people) {
    const description = person.events?.find((event) => event.gedcomTag === "MARR")?.description || "";
    assert.equal((description.match(/City, County, State, Country/g) || []).length, 1);
    assert.deepEqual(person.events?.find((event) => event.gedcomTag === "MARR")?.location,
      { place, lat: 42, lon: -116 });
    assert.equal(person.biography?.includes(defaultForm) || false, false);
  }
});

test("qualified or absent family-event date never deduplicates a different metadata event", () => {
  const input = ["0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Alex /Example/",
    "0 @I2@ INDI", "1 NAME Sam /Example/", "0 @F1@ FAM",
    "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR Y", "2 DATE 1900",
    `2 PLAC ${place}`, `3 FORM ${localForm}`, "0 TRLR"].join("\n");
  const original = exportGedcom(importGedcom(input, "family-form").family, { version: "7.0" });
  for (const [dateLine, dateContext] of [
    ["2 DATE ABT 1910\r\n", "DATE ABT 1910"],
    ["", "DATE не указана"],
  ]) {
    const changed = original.replace(
      `1 MARR Y\r\n2 DATE 1900\r\n2 PLAC ${place}`,
      `1 MARR Y\r\n${dateLine}2 PLAC ${place}\r\n3 FORM ${localForm}`);
    assert.notEqual(changed, original);
    const first = importGedcom(changed, "family-form-changed");
    for (const person of first.family.people) {
      assert.match(person.biography || "", new RegExp(dateContext));
      assert.match(person.biography || "", new RegExp(localForm));
      assert.equal(person.events?.find((event) => event.gedcomTag === "MARR")?.date, "1900");
    }
    const again = importGedcom(exportGedcom(first.family, { version: "7.0" }), "family-form-again");
    for (let index = 0; index < first.family.people.length; index++)
      assert.equal(again.family.people[index].biography, first.family.people[index].biography);
  }
});

test("GEDZIP preview retains place FORM from the imported GEDCOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedzip-place-form-"));
  try {
    const path = join(directory, "input.gdz"), stage = join(directory, "stage");
    await mkdir(stage);
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(sample("7.0")), "gedcom.ged");
    await new Promise<void>((resolve, reject) => {
      zip.outputStream.pipe(createWriteStream(path))
        .once("finish", resolve).once("error", reject);
      zip.end();
    });
    const result = await prepareGenealogyImport(path, stage, "zip-form");
    assert.match(result.family.people[0].events?.find((event) =>
      event.gedcomTag === "BIRT")?.description || "", new RegExp(defaultForm));
    assert.match(result.family.people[0].sources[0].note || "", new RegExp(localForm));
    assert.ok(result.warnings.some((warning) => /PLAC\.FORM/.test(warning)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
