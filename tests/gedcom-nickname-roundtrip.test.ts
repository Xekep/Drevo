import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { Family } from "../src/domain/types.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";

const family: Family = {
  title: "Семейный архив", description: "", demo: false, photos: [],
  people: [{
    id: "parent", name: "Анна", surname: "Иванова", patronymic: "", sex: "f",
    birth: "1900", birthPlace: "Тула", parents: [], spouses: [], sources: [],
    generation: 1, column: 0, biography: "Записана в переписи 1905 года.",
  }, {
    id: "child", name: "Мария", surname: "Иванова", patronymic: "", sex: "f",
    birth: "1920", birthPlace: "Тула", parents: ["parent"], spouses: [], sources: [],
    generation: 2, column: 0,
  }],
};

function withExternalNickname(version: "5.5.1" | "7.0") {
  const exported = exportGedcom(family, { version });
  assert.match(exported, /2 SURN Иванова/);
  return exported.replace("2 SURN Иванова", "2 SURN Иванова\n2 NICK Нюра");
}

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} nickname remains visible through Drevo round-trip`, () => {
    const imported = importGedcom(withExternalNickname(version), `external-${version}`);
    const anna = imported.family.people[0];
    assert.equal(anna.biography, "Записана в переписи 1905 года.\n\nПрозвища из GEDCOM: Нюра");
    assert.ok(imported.warnings.some((warning) => warning.includes("NAME.NICK") &&
      warning.includes("структура")));
    assert.deepEqual(imported.family.people[1].parents, [anna.id]);

    const restored = importGedcom(exportGedcom(imported.family, { version }), `restored-${version}`);
    assert.equal(restored.family.people[0].biography, anna.biography);
    assert.equal(restored.family.people[0].birthPlace, "Тула");
    assert.deepEqual(restored.family.people[1].parents, [restored.family.people[0].id]);
    assert.ok(!restored.warnings.some((warning) => warning.includes("NAME.NICK")));
  });

test(".drevo preserves the nickname text imported from an external GEDCOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-nickname-roundtrip-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const imported = importGedcom(withExternalNickname("7.0"), "external-portable");
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: imported.family, documents: [], comments: [], sources: [],
    }, async () => {});
    const restored = await readPortablePackage(path, stage);
    assert.equal(restored.snapshot.family.people[0].biography,
      "Записана в переписи 1905 года.\n\nПрозвища из GEDCOM: Нюра");
    assert.deepEqual(restored.snapshot.family.people[1].parents,
      [restored.snapshot.family.people[0].id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
