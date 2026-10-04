import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";

const familyAges = (version: "5.5.1" | "7.0") => [
  "0 HEAD", "1 SOUR TEST", "1 GEDC", `2 VERS ${version}`,
  ...(version === "5.5.1" ? ["2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"] : []),
  "0 @I1@ INDI", "1 NAME Alex /Example/", "1 SEX M",
  "1 CENS", "2 DATE 1901", "2 AGE 26y",
  "0 @I2@ INDI", "1 NAME Sam /Example/", "1 SEX F",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I1@",
  "1 MARR Y", "2 DATE 1 JAN 1900", "2 PLAC Testville",
  "2 SOUR @S1@", "3 PAGE p. 2",
  "2 HUSB", "3 AGE 25y",
  ...(version === "7.0" ? ["4 PHRASE about twenty-five"] : []),
  "2 WIFE", "3 AGE 22y",
  "1 CENS Y", "2 DATE 1902", "2 HUSB", "3 AGE 27y",
  "1 DIV Y", "2 DATE 1903", "2 WIFE", "3 AGE 24y",
  "0 @S1@ SOUR", "1 TITL Marriage register", "0 TRLR",
].join("\n");

function checkAges(result: ReturnType<typeof importGedcom>, version: "5.5.1" | "7.0",
  expectWarning = true) {
  const [alex, sam] = result.family.people;
  const event = (person: typeof alex, tag: string) =>
    person.events?.find((item) => item.gedcomTag === tag);
  assert.match(event(alex, "CENS")?.description || "", /26y/);
  assert.match(event(alex, "MARR")?.description || "", /22y/);
  assert.doesNotMatch(event(alex, "MARR")?.description || "", /25y/);
  assert.match(event(sam, "MARR")?.description || "", /25y/);
  assert.doesNotMatch(event(sam, "MARR")?.description || "", /22y/);
  if (version === "7.0")
    assert.match(event(sam, "MARR")?.description || "", /about twenty-five/);
  assert.match(event(sam, "CENS")?.description || "", /27y/);
  assert.match(event(alex, "DIV")?.description || "", /24y/);
  assert.equal(event(alex, "MARR")?.date, "1900-01-01");
  assert.equal(event(alex, "MARR")?.place, "Testville");
  assert.equal(event(alex, "MARR")?.sources?.[0]?.title, "Marriage register");
  assert.equal(event(alex, "MARR")?.sources?.[0]?.reference, "p. 2");
  assert.equal(result.family.unions?.[0]?.formation?.date, "1900-01-01");
  assert.equal(result.family.unions?.[0]?.formation?.place, "Testville");
  if (expectWarning)
    assert.ok(result.warnings.some((warning) => /AGE/.test(warning) && /семейн/.test(warning)));
}

for (const version of ["5.5.1", "7.0"] as const) {
  test(`GEDCOM ${version} preserves family-event ages only on their recorded participants`, () => {
    const first = importGedcom(familyAges(version), `family-age-${version}`);
    checkAges(first, version);
    const second = importGedcom(exportGedcom(first.family, { version }), `again-${version}`);
    checkAges(second, version, false);
    for (const person of second.family.people)
      for (const item of person.events || [])
        for (const age of ["22y", "24y", "25y", "26y", "27y"])
          assert.ok((item.description?.match(new RegExp(age, "g")) || []).length <= 1);
  });
}

test("unresolved family-event AGE is explicitly warned about", () => {
  const source = familyAges("7.0");
  for (const altered of [
    source.replace("1 HUSB @I2@", "1 HUSB @VOID@"),
    source.replace("1 HUSB @I2@", "1 HUSB @I2@\n1 HUSB @I1@"),
  ]) {
    const result = importGedcom(altered, "unresolved-age");
    assert.ok(result.warnings.some((warning) =>
      /AGE не перенесён.*участник семьи/.test(warning)));
    assert.equal(result.family.people.some((person) => person.events?.some((event) =>
      event.description?.includes("25y"))), false);
  }
  const voidHusband = importGedcom(source.replace("1 HUSB @I2@", "1 HUSB @VOID@"),
    "void-husband-age");
  assert.match(voidHusband.family.people[0].events?.find((event) =>
    event.gedcomTag === "MARR")?.description || "", /22y/);
});

test("new family AGE beside Drevo metadata is preserved without duplicating existing age", () => {
  const original = importGedcom(familyAges("7.0"), "original-age");
  const exported = exportGedcom(original.family, { version: "7.0" });
  const addHusbandAge = (age: string, phrase?: string) => exported.replace(
    /(1 MARR Y\r?\n)/,
    (_whole, start: string) => `${start}2 HUSB\r\n3 AGE ${age}\r\n${phrase ? `4 PHRASE ${phrase}\r\n` : ""}`,
  );
  // Drevo reassigns HUSB/WIFE by the saved sexes; Alex was WIFE in the source
  // but is HUSB in the exported FAM. The recorded age is still the same.
  const duplicate = importGedcom(addHusbandAge("22y"), "duplicate-age");
  const samePerson = duplicate.family.people[0];
  assert.equal((samePerson.events?.find((event) => event.gedcomTag === "MARR")
    ?.description?.match(/22y/g) || []).length, 1);
  assert.equal(samePerson.biography?.includes("22y") || false, false);
  assert.equal(duplicate.warnings.some((warning) => /AGE.*не перенесён/.test(warning)), false);

  const added = importGedcom(addHusbandAge("29y", "from family record"), "added-age");
  const person = added.family.people[0];
  assert.match(person.biography || "", /MARR/);
  assert.match(person.biography || "", /29y/);
  assert.match(person.biography || "", /from family record/);
  assert.ok(added.warnings.some((warning) => /AGE/.test(warning) && /биограф/.test(warning)));
  const again = importGedcom(exportGedcom(added.family, { version: "7.0" }), "added-age-back");
  assert.equal(again.family.people[0].biography, person.biography);

  const ambiguousFamily = structuredClone(original.family);
  const marriage = ambiguousFamily.people[0].events?.find((event) => event.gedcomTag === "MARR");
  assert.ok(marriage);
  ambiguousFamily.people[0].events?.push({ ...marriage, id: "other-marriage" });
  const ambiguousGedcom = exportGedcom(ambiguousFamily, { version: "7.0" });
  const ambiguous = importGedcom(ambiguousGedcom.replace(
    /(1 MARR Y\r?\n)/, (_whole, start: string) => `${start}2 HUSB\r\n3 AGE 22y\r\n`,
  ), "ambiguous-age");
  assert.match(ambiguous.family.people[0].biography || "", /22y/);
  assert.ok(ambiguous.warnings.some((warning) => /AGE/.test(warning) && /биограф/.test(warning)));
});

test("GEDZIP and .drevo paths retain family-event ages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-family-age-"));
  try {
    const zipPath = join(directory, "input.gdz"), stage = join(directory, "stage"),
      uploads = join(directory, "uploads");
    await mkdir(stage);
    await mkdir(uploads);
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(familyAges("7.0")), "gedcom.ged");
    await new Promise<void>((resolve, reject) => {
      zip.outputStream.pipe(createWriteStream(zipPath))
        .once("finish", resolve).once("error", reject);
      zip.end();
    });
    const parsed = await prepareGenealogyImport(zipPath, stage, "zipped-age");
    checkAges(parsed, "7.0");
    const portablePath = join(directory, "family-age.drevo");
    await writePortablePackage(createWriteStream(portablePath), uploads, {
      family: parsed.family, documents: [], comments: [], sources: [],
    }, async () => {});
    const portable = await readPortablePackage(portablePath, stage);
    assert.match(portable.snapshot.family.people[0].events?.find((item) =>
      item.gedcomTag === "MARR")?.description || "", /22y/);
    assert.match(portable.snapshot.family.people[1].events?.find((item) =>
      item.gedcomTag === "MARR")?.description || "", /25y/);
    checkAges(importGedcom(exportGedcom(portable.snapshot.family, { version: "7.0" }),
      "portable-age-back"), "7.0", false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
