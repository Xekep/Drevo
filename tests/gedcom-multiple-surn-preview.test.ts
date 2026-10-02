import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

function externalSurname(nameLine: string, parts: string[]) {
  return [
    "0 HEAD", "1 GEDC", "2 VERS 7.0", "1 CHAR UTF-8",
    "0 @I1@ INDI", `1 NAME ${nameLine}`, "2 GIVN Juan",
    ...parts.map((part) => `2 SURN ${part}`),
    "1 BIRT", "2 DATE 1 JAN 1900", "2 PLAC Bogota", "0 TRLR",
  ].join("\n");
}

for (const { label, nameLine, parts, surname, displaySource } of [
  {
    label: "matching slash form",
    nameLine: "Juan /Hernandez Martinez/",
    parts: ["Hernandez", "Martinez"],
    surname: "Hernandez Martinez",
    displaySource: "строки NAME",
  },
  {
    label: "no slash form",
    nameLine: "Juan Hernandez Martinez",
    parts: ["Hernandez", "Martinez"],
    surname: "Hernandez",
    displaySource: "первого SURN",
  },
  {
    label: "conflicting slash form",
    nameLine: "Juan /Hernandez/",
    parts: ["Garcia", "Martinez"],
    surname: "Hernandez",
    displaySource: "строки NAME",
  },
] as const)
  test(`GEDCOM 7 repeated SURN with ${label} is preserved and previewed`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "drevo-multiple-surn-"));
    const stage = join(directory, "stage");
    await mkdir(stage);
    try {
      const path = join(directory, "source.ged");
      await writeFile(path, externalSurname(nameLine, [...parts]));
      const preview = await prepareGenealogyImport(path, stage, `surn-${label}`);
      const person = preview.family.people[0];
      assert.equal(person.name, "Juan");
      assert.equal(person.surname, surname);
      assert.ok(person.biography?.includes(`Исходная строка NAME: ${nameLine}`));
      for (const [index, part] of parts.entries())
        assert.ok(person.biography?.includes(`NAME.SURN ${index + 1}: ${part}`));
      assert.ok(preview.warnings.some((warning) => warning.includes("NAME.SURN") &&
        warning.includes("структура") && warning.includes(displaySource)),
      "preview must explain the lost piece structure and display choice");

      const restored = importGedcom(exportGedcom(preview.family, { version: "7.0" }), "again");
      assert.equal(restored.family.people[0].surname, surname);
      assert.equal(restored.family.people[0].biography, person.biography);
      assert.equal(restored.family.people[0].birthPlace, "Bogota");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("GEDCOM 7 repeated SURN remains visible when Drevo metadata is present", () => {
  const family = importGedcom(externalSurname("Juan /Hernandez/", ["Hernandez"]), "base").family;
  const exported = exportGedcom(family, { version: "7.0" });
  const edited = exported.replace(
    /1 NAME Juan \/Hernandez\/\r?\n2 GIVN Juan\r?\n2 SURN Hernandez/,
    "1 NAME Juan /Hernandez Martinez/\r\n2 GIVN Juan\r\n2 SURN Hernandez\r\n2 SURN Martinez",
  );
  assert.notEqual(edited, exported, "fixture must change the exported name");

  const imported = importGedcom(edited, "with-drevo-extra");
  assert.equal(imported.family.people[0].surname, "Hernandez Martinez");
  assert.ok(imported.family.people[0].biography?.includes("NAME.SURN 2: Martinez"));
  assert.ok(imported.warnings.some((warning) => warning.includes("NAME.SURN")));
});
