import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

function externalPrefixes(version: "5.5.1" | "7.0") {
  const repeated = version === "7.0";
  return [
    "0 HEAD", "1 GEDC", `2 VERS ${version}`, "1 CHAR UTF-8",
    "0 @I1@ INDI",
    `1 NAME ${repeated ? "Dr. Prof." : "Dr."} Vincent /van Gogh/`,
    "2 NPFX Dr.",
    ...(repeated ? ["2 NPFX Prof."] : []),
    "2 GIVN Vincent", "2 SPFX van", "2 SURN Gogh",
    "1 NAME Sir Vincent /Gogh/", `2 TYPE ${repeated ? "AKA" : "aka"}`, "2 NPFX Sir",
    "1 BIRT", "2 DATE 1 JAN 1900", "2 PLAC Arles",
    "0 TRLR",
  ].join("\n");
}

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} previews name prefixes and retains their text through export`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "drevo-name-prefix-"));
    const stage = join(directory, "stage");
    await mkdir(stage);
    try {
      const path = join(directory, "source.ged");
      await writeFile(path, externalPrefixes(version));
      const preview = await prepareGenealogyImport(path, stage, `prefix-${version}`);
      const person = preview.family.people[0];
      assert.equal(person.name, "Vincent");
      assert.equal(person.surname, "Gogh");
      assert.ok(person.biography?.includes(
        `NAME 1: ${version === "7.0" ? "Dr. Prof." : "Dr."} Vincent /van Gogh/`,
      ));
      assert.ok(person.biography?.includes("NPFX: Dr."));
      if (version === "7.0") assert.ok(person.biography?.includes("NPFX: Prof."));
      assert.ok(person.biography?.includes("SPFX: van"));
      assert.ok(person.biography?.includes("NAME 2: Sir Vincent /Gogh/"));
      assert.ok(person.biography?.includes(`TYPE: ${version === "7.0" ? "AKA" : "aka"}`));
      assert.ok(person.biography?.includes("NPFX: Sir"));
      assert.ok(preview.warnings.some((warning) => warning.includes("NAME.NPFX") &&
        warning.includes("NAME.SPFX") && warning.includes("структура")));

      const exported = exportGedcom(preview.family, { version });
      const restored = importGedcom(exported, `again-${version}`);
      assert.equal(restored.family.people[0].biography, person.biography);
      assert.equal(restored.family.people[0].birthPlace, "Arles");
      const withoutDrevoMetadata = exported.replace(
        /^1 _DREVO .*(?:\r?\n2 (?:CONC|CONT).*)*\r?\n/gm,
        "",
      );
      assert.ok(importGedcom(withoutDrevoMetadata, `external-${version}`)
        .family.people[0].biography?.includes("NPFX: Dr."));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
