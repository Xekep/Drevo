import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

function externalGivenNames(version: "5.5.1" | "7.0") {
  return [
    "0 HEAD", "1 GEDC", `2 VERS ${version}`, "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Alice /Smith/", "2 GIVN Alice",
    "2 GIVN Alicia", "2 SURN Smith", "1 BIRT", "2 PLAC London",
    "1 NAME Mary /Smith/", "2 TYPE AKA", "2 GIVN Mary",
    "2 GIVN Molly", "2 SURN Smith", "0 TRLR",
  ].join("\n");
}

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} repeated GIVN survives preview and round-trip as text`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "drevo-multiple-givn-"));
    const stage = join(directory, "stage");
    await mkdir(stage);
    try {
      const path = join(directory, "source.ged");
      await writeFile(path, externalGivenNames(version));
      const preview = await prepareGenealogyImport(path, stage, `givn-${version}`);
      const person = preview.family.people[0];
      assert.equal(person.name, "Alice");
      assert.equal(person.surname, "Smith");
      assert.equal(person.birthPlace, "London");
      for (const detail of [
        "NAME 1: Alice /Smith/", "NAME.GIVN 1: Alice", "NAME.GIVN 2: Alicia",
        "NAME 2: Mary /Smith/", "TYPE: AKA",
        "NAME.GIVN 1: Mary", "NAME.GIVN 2: Molly",
      ]) assert.ok(person.biography?.includes(detail), `missing ${detail}`);
      assert.ok(preview.warnings.some((warning) => warning.includes("NAME.GIVN") &&
        warning.includes("структура") && warning.includes("первого GIVN")),
      "preview must explain the selected displayed name and lost structure");

      const restored = importGedcom(exportGedcom(preview.family, { version }), `again-${version}`);
      assert.equal(restored.family.people[0].biography, person.biography);
      assert.equal(restored.family.people[0].birthPlace, "London");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("repeated GIVN remains visible when Drevo metadata already supplies the biography", () => {
  const family = importGedcom(externalGivenNames("7.0").replaceAll("2 GIVN Alicia\n", "")
    .replaceAll("2 GIVN Molly\n", ""), "base").family;
  const exported = exportGedcom(family, { version: "7.0" });
  const edited = exported.replace("2 GIVN Alice\r\n", "2 GIVN Alexandra\r\n2 GIVN Alicia\r\n");
  assert.notEqual(edited, exported);
  const imported = importGedcom(edited, "edited");
  assert.equal(imported.family.people[0].name, "Alice");
  assert.ok(imported.family.people[0].biography?.includes("NAME.GIVN 1: Alexandra"));
  assert.ok(imported.family.people[0].biography?.includes("NAME.GIVN 2: Alicia"));
  assert.ok(imported.warnings.some((warning) => warning.includes("NAME.GIVN") &&
    warning.includes("метаданных Drevo")));
});

test("an empty first GIVN retains the later value without replacing the slash name", () => {
  const text = externalGivenNames("7.0").replace(
    "2 GIVN Alice\n2 GIVN Alicia",
    "2 GIVN\n2 GIVN Alicia",
  );
  const imported = importGedcom(text, "empty-first");
  assert.equal(imported.family.people[0].name, "Alice");
  assert.ok(imported.family.people[0].biography?.includes("NAME.GIVN 2: Alicia"));
  assert.ok(imported.warnings.some((warning) => warning.includes("NAME.GIVN") &&
    warning.includes("строки основного NAME")));
});

test("repeated GIVN retains the source value's spacing as text", () => {
  const text = externalGivenNames("7.0").replace("2 GIVN Alicia", "2 GIVN  Alicia ");
  const imported = importGedcom(text, "spaced");
  const biography = imported.family.people[0].biography;
  assert.ok(biography?.includes("NAME.GIVN 2:  Alicia \n"));
  const restored = importGedcom(exportGedcom(imported.family, { version: "7.0" }), "restored");
  assert.equal(restored.family.people[0].biography, biography);
});
