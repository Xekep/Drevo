import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAgelongXml } from "../src/domain/agelong-xml.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

const lifespanNote = "Оценка возраста из XML: Около 85";
const xml = (drevo = "") => `<?xml version="1.0" encoding="utf-8"?>
<agelongtree><persons><person id="1" fn="Anna" sn="Example"
  bdate="Около 1696" ddate="1781" lifespan="Около 85">
  <comment>Existing note</comment>${drevo}</person></persons></agelongtree>`;

test("Agelong lifespan estimate is previewed and survives GEDCOM 7 as text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-xml-lifespan-"));
  const stage = join(directory, "stage");
  await mkdir(stage);
  try {
    const path = join(directory, "source.xml");
    await writeFile(path, xml());
    const preview = await prepareGenealogyImport(path, stage, "lifespan-preview");
    const person = preview.family.people[0];
    assert.equal(person.birth, "", "approximate birth must not become an exact date");
    assert.ok(person.events?.some((event) => event.dateText === "Около 1696"));
    assert.equal(person.biography, `Existing note\n${lifespanNote}`);
    assert.ok(preview.warnings.some((warning) => warning.includes("person.lifespan") &&
      warning.includes("структура")), "preview must disclose the textual fallback");

    const restored = importGedcom(exportGedcom(preview.family, { version: "7.0" }), "restored");
    assert.equal(restored.family.people[0].biography, person.biography);
    assert.equal(restored.family.people[0].birth, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agelong lifespan text already in Drevo metadata is not duplicated", () => {
  const first = importAgelongXml(xml(), "lifespan-first");
  const imported = importAgelongXml(
    xml(`<drevo>${JSON.stringify({ biography: first.family.people[0].biography })}</drevo>`),
    "lifespan-metadata",
  );
  assert.equal(imported.family.people[0].biography, first.family.people[0].biography);
  assert.equal(imported.family.people[0].biography?.split(lifespanNote).length, 2);
  assert.ok(imported.warnings.some((warning) => warning.includes("person.lifespan")));
});
