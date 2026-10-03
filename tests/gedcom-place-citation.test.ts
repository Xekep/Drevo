import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";

const external = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Анна /Тестова/
1 BIRT
2 DATE 1900
2 SOUR @S3@
2 PLAC Тула
3 SOUR @S1@
4 PAGE л. 3
1 DEAT
2 DATE 1980
2 PLAC Казань
3 SOUR @S2@
4 PAGE л. 9
0 @S1@ SOUR
1 TITL Книга рождений
0 @S2@ SOUR
1 TITL Книга смертей
0 @S3@ SOUR
1 TITL Общее свидетельство рождения
0 TRLR`;

test("GEDCOM 5.5.1 PLAC.SOUR becomes evidence for the exact birth/death place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedcom-place-citation-"));
  try {
    const input = join(directory, "places.ged"), stage = join(directory, "stage"),
      uploads = join(directory, "uploads");
    await mkdir(stage);
    await mkdir(uploads);
    await writeFile(input, external);
    const parsed = await prepareGenealogyImport(input, stage, "external-places");
    const person = parsed.family.people[0];
    assert.equal(person.birthPlaceClaim?.value, "Тула");
    assert.equal(person.birthPlaceClaim?.sources[0].reference, "л. 3");
    assert.equal(person.birthPlaceClaim?.sources[0].title, "Книга рождений");
    assert.equal(person.deathPlaceClaim?.value, "Казань");
    assert.equal(person.deathPlaceClaim?.sources[0].reference, "л. 9");
    assert.equal(person.deathPlaceClaim?.sources[0].title, "Книга смертей");
    assert.deepEqual(person.sources.map((citation) => citation.title),
      ["Общее свидетельство рождения"]);
    for (const version of ["5.5.1", "7.0"] as const) {
      const text = exportGedcom(parsed.family, { version });
      assert.match(text, /3 _DREVO_CLAIM BIRTH_PLACE/);
      assert.match(text, /3 _DREVO_CLAIM DEATH_PLACE/);
      const roundtrip = importGedcom(text, `place-${version}`).family.people[0];
      assert.equal(roundtrip.birthPlaceClaim?.sources[0].reference, "л. 3");
      assert.equal(roundtrip.deathPlaceClaim?.sources[0].reference, "л. 9");
      assert.equal(roundtrip.birthPlaceClaim?.value, "Тула");
      assert.equal(roundtrip.deathPlaceClaim?.value, "Казань");
    }
    const portablePath = join(directory, "places.drevo");
    await writePortablePackage(createWriteStream(portablePath), uploads, {
      family: parsed.family, documents: [], comments: [], sources: [],
    }, async () => {});
    const portable = await readPortablePackage(portablePath, stage);
    assert.equal(portable.snapshot.family.people[0].birthPlaceClaim?.sources[0].reference, "л. 3");
    assert.equal(portable.snapshot.family.people[0].deathPlaceClaim?.sources[0].reference, "л. 9");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a PLAC.SOUR without a place value stays as a general citation", () => {
  const input = external.replace("2 PLAC Тула", "2 PLAC");
  const imported = importGedcom(input, "empty-place");
  const result = imported.family.people[0];
  assert.equal(result.birthPlaceClaim, undefined);
  assert.deepEqual(result.sources.map((citation) => citation.title),
    ["Общее свидетельство рождения", "Книга рождений"]);
  assert.equal(result.sources[1].reference, "л. 3");
  assert.equal(result.deathPlaceClaim?.sources[0].reference, "л. 9");
  assert.ok(imported.warnings.some((warning) => warning.includes("Источник места без названия")));
});

test("nonstandard place citation on a regular event remains with that event", async () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    const input = [
      "0 HEAD", "1 GEDC", `2 VERS ${version}`,
      "0 @I1@ INDI", "1 NAME Anna /Test/",
      "1 RESI", "2 DATE 1910", "2 SOUR @S2@", "3 PAGE leaf 1", "2 PLAC Tula",
      "3 SOUR @S1@", "4 PAGE leaf 3",
      "0 @S1@ SOUR", "1 TITL Address book",
      "0 @S2@ SOUR", "1 TITL Event register", "0 TRLR", "",
    ].join("\n");
    const imported = importGedcom(input, `event-place-${version}`);
    const residence = imported.family.people[0].events!.find((event) => event.gedcomTag === "RESI")!;
    assert.equal(residence.placeClaim, undefined);
    assert.deepEqual(residence.sources?.map((source) => [source.title, source.reference]),
      [["Event register", "leaf 1"], ["Address book", "leaf 3"]]);
    assert.ok(imported.warnings.some((warning) => warning.includes("PLAC.SOUR") &&
      warning.includes("общий источник события")));

    const directory = await mkdtemp(join(tmpdir(), "drevo-event-place-citation-"));
    try {
      const file = join(directory, "places.ged"), stage = join(directory, "stage");
      await mkdir(stage);
      await writeFile(file, input);
      const preview = await prepareGenealogyImport(file, stage, `event-place-${version}`);
      assert.ok(preview.warnings.some((warning) => warning.includes("PLAC.SOUR")));
    } finally { await rm(directory, { recursive: true, force: true }); }

    const roundtrip = importGedcom(exportGedcom(imported.family, { version }),
      `event-place-roundtrip-${version}`);
    const restored = roundtrip.family.people[0].events!.find((event) => event.gedcomTag === "RESI")!;
    assert.deepEqual(restored.sources?.map((source) => [source.title, source.reference]),
      [["Event register", "leaf 1"], ["Address book", "leaf 3"]]);
    assert.equal(restored.placeClaim, undefined);
  }
});
