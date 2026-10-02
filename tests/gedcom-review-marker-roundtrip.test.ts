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
import type { Family } from "../src/domain/types.ts";

const family: Family = {
  title: "Archive", description: "", demo: false, photos: [],
  people: [{
    id: "person", name: "Anna", surname: "Ivanova", patronymic: "", sex: "f",
    birth: "1900", birthPlace: "Tula", parents: [], spouses: [], sources: [],
    generation: 1, column: 0, needsReview: true,
  }],
};

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} keeps a person's manual needs-review marker`, () => {
    const exported = exportGedcom(family, { version });
    assert.match(exported, /"needsReview":true/);
    const restored = importGedcom(exported, `review-${version}`);
    assert.equal(restored.family.people[0].needsReview, true);
    const unchecked = structuredClone(family);
    unchecked.people[0].needsReview = false;
    assert.equal(importGedcom(exportGedcom(unchecked, { version }),
      `unchecked-${version}`).family.people[0].needsReview, false);
  });

test("GEDZIP keeps the manual needs-review marker through staged import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedzip-review-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(directory, "family.gdz");
    await writeGenealogyPackage(path, uploads, family, []);
    const restored = await prepareGenealogyImport(path, stage, "review-gedzip");
    assert.equal(restored.family.people[0].needsReview, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(".drevo already keeps the manual needs-review marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-portable-review-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family, documents: [], comments: [], sources: [],
    }, async () => {});
    const restored = await readPortablePackage(path, stage);
    assert.equal(restored.snapshot.family.people[0].needsReview, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
