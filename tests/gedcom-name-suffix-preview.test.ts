import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { Family } from "../src/domain/types.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

const family: Family = {
  title: "Именной архив", description: "", demo: false, photos: [],
  people: [{
    id: "ivan", name: "Иван", surname: "Соколов", patronymic: "", sex: "m",
    birth: "1900", birthPlace: "Тверь", parents: [], spouses: [], sources: [],
    generation: 1, column: 0, biography: "Записан в метрической книге.",
  }],
};

function externalSuffix(version: "5.5.1" | "7.0") {
  const suffixes = version === "7.0" ? "2 NSFX Jr.\n2 NSFX MD" : "2 NSFX Jr.";
  const gedcom = exportGedcom(family, { version });
  return gedcom.replace("1 NAME Иван /Соколов/\r\n2 GIVN Иван\r\n2 SURN Соколов",
    `1 NAME Иван /Соколов/ Jr.\r\n2 GIVN Иван\r\n2 SURN Соколов\r\n${suffixes.replaceAll("\n", "\r\n")}`);
}

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} previews and retains NAME.NSFX through export`, async () => {
    const root = await mkdtemp(join(tmpdir(), "drevo-name-suffix-"));
    const stage = join(root, "stage");
    await mkdir(stage);
    try {
      const path = join(root, "source.ged");
      await writeFile(path, externalSuffix(version));
      const preview = await prepareGenealogyImport(path, stage, `suffix-${version}`);
      const imported = preview.family.people[0];
      const suffixText = version === "7.0" ? "Jr.; MD" : "Jr.";
      assert.equal(imported.name, "Иван");
      assert.equal(imported.surname, "Соколов");
      assert.equal(imported.biography,
        `Записан в метрической книге.\n\nСуффиксы имени из GEDCOM: ${suffixText}`);
      assert.ok(preview.warnings.some((warning) => warning.includes("NAME.NSFX") &&
        warning.includes("структура")), "preview must disclose loss of the structured suffix");

      const again = importGedcom(exportGedcom(preview.family, { version }), `again-${version}`);
      assert.equal(again.family.people[0].biography, imported.biography);
      assert.equal(again.family.people[0].birthPlace, "Тверь");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
