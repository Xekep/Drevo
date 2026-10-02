import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { collectPersonSources, repositorySummary } from "../src/domain/person-sources.ts";

const external = (version: "5.5.1" | "7.0") => `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS ${version}
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 BIRT
2 DATE 1 JAN 1900
2 SOUR @S1@
3 PAGE leaf 3
3 NOTE birth entry
1 DEAT
2 DATE 1 JAN 1980
2 SOUR @S1@
3 PAGE leaf 9
3 NOTE death entry
0 @S1@ SOUR
1 TITL Parish register
1 NOTE URL: https://source.example/book
1 REPO @R1@
2 CALN F.6/13/104
2 NOTE reading room only
0 @R1@ REPO
1 NAME State archive
1 WWW https://repository.example
1 NOTE appointment required
0 TRLR`;

const repository = {
  name: "State archive",
  callNumber: "F.6/13/104",
  website: "https://repository.example",
  note: "appointment required",
  linkNote: "reading room only",
};

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} restores one repository structurally without merging it into source URL`, () => {
    const imported = importGedcom(external(version), `repo-${version}`);
    const [birth, death] = imported.family.people[0].events!
      .filter((event) => ["BIRT", "DEAT"].includes(event.gedcomTag || ""))
      .map((event) => event.sources![0]);
    assert.deepEqual([birth.reference, death.reference], ["leaf 3", "leaf 9"]);
    assert.deepEqual([birth.repository, death.repository], [repository, repository]);
    assert.match(repositorySummary(birth), /State archive.*F\.6\/13\/104/);
    assert.equal(birth.url, "https://source.example/book");
    assert.equal(death.url, "https://source.example/book");
    assert.equal(birth.note, "birth entry");
    assert.equal(death.note, "death entry");
    assert.ok(!imported.warnings.some((warning) => warning.includes("структура REPO")));

    const exported = exportGedcom(imported.family, { version });
    assert.match(exported, /1 REPO @R\d+@\r?\n2 CALN F\.6\/13\/104\r?\n2 NOTE reading room only/);
    assert.match(exported, /0 @R\d+@ REPO\r?\n1 NAME State archive\r?\n1 WWW https:\/\/repository\.example\r?\n1 NOTE appointment required/);
    assert.match(exported, /3 PAGE leaf 3/);
    assert.match(exported, /3 PAGE leaf 9/);
    // A different GEDCOM reader need not understand Drevo's private JSON.
    const standard = exported.replace(/^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm, "");
    const roundtrip = importGedcom(standard, `roundtrip-${version}`).family.people[0].events!
      .filter((event) => ["BIRT", "DEAT"].includes(event.gedcomTag || ""))
      .map((event) => event.sources![0]);
    assert.deepEqual(roundtrip.map((source) => source.repository), [repository, repository]);
    assert.deepEqual(roundtrip.map((source) => source.reference), ["leaf 3", "leaf 9"]);
    assert.deepEqual(roundtrip.map((source) => source.note), ["birth entry", "death entry"]);
  });

test("repository travels through GEDZIP and .drevo without an archive-local catalog ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-repository-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const family = importGedcom(external("7.0"), "repository").family;
    const gedzip = join(directory, "repository.gdz");
    await writeGenealogyPackage(gedzip, uploads, family, []);
    const importedZip = await prepareGenealogyImport(gedzip, stage, "zip");
    assert.deepEqual(importedZip.family.people[0].events?.[0].sources?.[0].repository, repository);
    assert.equal(importedZip.family.people[0].events?.[0].sources?.[0].catalogId, undefined);

    const portablePath = join(directory, "repository.drevo");
    await writePortablePackage(createWriteStream(portablePath), uploads,
      { family, documents: [], comments: [], sources: [] }, async () => {});
    const portable = await readPortablePackage(portablePath, stage);
    assert.deepEqual(portable.snapshot.family.people[0].events?.[1].sources?.[0].repository, repository);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy inline sources never synthesize REPO; excess repositories stay text with warning", () => {
  const plain = importGedcom(external("7.0").replace(/1 REPO @R1@[\s\S]*?(?=0 TRLR)/,
    "0 @R1@ REPO\n1 NAME State archive\n"), "plain").family;
  assert.equal(plain.people[0].events?.[0].sources?.[0].repository, undefined);
  assert.doesNotMatch(exportGedcom(plain, { version: "7.0" }), /1 REPO @R\d+@/);

  const additional = external("7.0").replace("0 @R1@ REPO",
    "1 REPO @R2@\n2 CALN Other/1\n0 @R2@ REPO\n1 NAME Other archive\n0 @R1@ REPO");
  const parsed = importGedcom(additional, "two-repositories");
  const source = parsed.family.people[0].events?.[0].sources?.[0];
  assert.equal(source?.repository, undefined);
  assert.match(source?.note || "", /State archive/);
  assert.match(source?.note || "", /Other archive/);
  assert.ok(parsed.warnings.some((warning) => warning.includes("структура REPO")));

  const separate = structuredClone(parsed.family.people[0]);
  separate.sources = [
    { title: "Register", type: "", reference: "leaf 3", repository },
    { title: "Register", type: "", reference: "leaf 3",
      repository: { ...repository, name: "Other archive" } },
  ];
  assert.equal(collectPersonSources(separate)
    .filter((source) => source.title === "Register").length, 2);

  const repeated = importGedcom(external("7.0")
    .replace("2 CALN F.6/13/104", "2 CALN F.6/13/104\n2 CALN F.7/1")
    .replace("1 WWW https://repository.example",
      "1 WWW https://repository.example\n1 WWW https://other.example"), "repeated");
  const repeatedSource = repeated.family.people[0].events?.[0].sources?.[0];
  assert.equal(repeatedSource?.repository, undefined);
  assert.match(repeatedSource?.note || "", /F\.7\/1/);
  assert.match(repeatedSource?.note || "", /https:\/\/other\.example/);
  assert.ok(repeated.warnings.some((warning) => warning.includes("структура REPO")));

  const invalid = structuredClone(parsed.family);
  invalid.people[0].events![0].sources![0].repository = {
    ...repository, name: "",
  };
  assert.throws(() => validateFamily(invalid), /источник/i);
  invalid.people[0].events![0].sources![0].repository = repository;
  invalid.people[0].events![0].sources![0].catalogId = "catalog-1";
  assert.throws(() => validateFamily(invalid), /источник/i);
});
