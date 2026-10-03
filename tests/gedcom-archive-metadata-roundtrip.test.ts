import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family } from "../src/domain/types.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";

const family: Family = {
  title: "The Ivanov family archive",
  description: "Records gathered in Tver from church books and family letters.",
  demo: false,
  people: [{
    id: "anna", name: "Anna", surname: "Ivanova", patronymic: "", sex: "f",
    birth: "1900", birthPlace: "Tver", parents: [], spouses: [],
    generation: 1, column: 0,
    sources: [{ title: "Parish register", type: "archive", reference: "folio 7" }],
  }],
  photos: [],
};

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} round-trip retains archive title and description`, () => {
    const text = exportGedcom(family, { version });
    assert.match(text, /1 SOUR DREVO\r?\n2 DATA The Ivanov family archive/);
    assert.match(text, /1 NOTE Records gathered in Tver from church books and fam/);
    const result = importGedcom(text, `archive-${version}`);
    assert.equal(result.family.title, family.title);
    assert.equal(result.family.description, family.description);
    assert.equal(result.family.people[0].birth, "1900");
    assert.equal(result.family.people[0].sources[0].reference, "folio 7");
    const standardOnly = text.replace(
      /^1 _DREVO_ARCHIVE[^\r\n]*(?:\r?\n2 (?:CONC|CONT)[^\r\n]*)*/m, "",
    );
    const withoutExtension = importGedcom(standardOnly, `standard-${version}`);
    assert.equal(withoutExtension.family.title, family.title);
    assert.equal(withoutExtension.family.description, family.description);
  });

test("GEDCOM 5.5.1 retains long archive metadata without overlong standard header fields", () => {
  const long: Family = {
    ...family,
    title: "Archive title ".repeat(10),
    description: "Provenance and scope of the collection. ".repeat(12),
  };
  const text = exportGedcom(long, { version: "5.5.1" });
  assert.doesNotMatch(text, /^2 DATA /m);
  assert.doesNotMatch(text, /^1 NOTE /m);
  const result = importGedcom(text, "long-archive");
  assert.equal(result.family.title, long.title);
  assert.equal(result.family.description, long.description);
});

test("an external GEDCOM header uses its standard database name and note", () => {
  const text = [
    "0 HEAD", "1 SOUR OTHER", "2 DATA External family archive",
    "1 GEDC", "2 VERS 7.0", "1 NOTE Documents from the village register.",
    "0 @I1@ INDI", "1 NAME Anna /Ivanova/", "0 TRLR", "",
  ].join("\n");
  const result = importGedcom(text, "external-header");
  assert.equal(result.family.title, "External family archive");
  assert.equal(result.family.description, "Documents from the village register.");
});

test("a damaged Drevo header falls back to standard metadata with a warning", () => {
  const text = exportGedcom(family, { version: "7.0" }).replace(
    /^1 _DREVO_ARCHIVE .*$/m, "1 _DREVO_ARCHIVE invalid-json",
  );
  const result = importGedcom(text, "damaged-header");
  assert.equal(result.family.title, family.title);
  assert.equal(result.family.description, family.description);
  assert.ok(result.warnings.some((warning) => warning.includes("Метаданные архива Drevo")));
});

test("GEDZIP round-trip retains archive title and description", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedzip-archive-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(directory, "archive.gdz");
    await writeGenealogyPackage(path, uploads, family, []);
    const result = await prepareGenealogyImport(path, stage, "archive-gedzip");
    assert.equal(result.family.title, family.title);
    assert.equal(result.family.description, family.description);
    assert.equal(result.family.people[0].sources[0].reference, "folio 7");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
