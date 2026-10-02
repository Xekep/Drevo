import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAgelongXml } from "../src/domain/agelong-xml.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

const externalXml = (fullname: string) => `<?xml version="1.0" encoding="utf-8"?>
<agelongtree><persons>
<person id="1" fn="Анна" sn="Соколова" mn="Ивановна" msn="Кузнецова"
  fullname="${fullname}" bdate="1900"><bplace id="p">Тула</bplace>
  <comment>Запись в семейном архиве.</comment></person>
</persons><places><place id="p" fullname="Тула" /></places></agelongtree>`;

test("Agelong XML preview retains custom text in fullname through GEDCOM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-xml-fullname-"));
  const stage = join(directory, "stage");
  await mkdir(stage);
  try {
    const path = join(directory, "source.xml");
    const fullname = "Соколова (Кузнецова) Анна Ивановна Сокол";
    await writeFile(path, externalXml(fullname));
    const preview = await prepareGenealogyImport(path, stage, "fullname-preview");
    const person = preview.family.people[0];
    assert.equal(person.surname, "Соколова");
    assert.equal(person.maidenName, "Кузнецова");
    assert.equal(person.birthPlace, "Тула");
    assert.ok(person.biography?.includes(`Полное имя из XML: ${fullname}`));
    assert.ok(preview.warnings.some((warning) => warning.includes("person.fullname") &&
      warning.includes("структура")), "preview must explain loss of the custom name structure");

    const restored = importGedcom(exportGedcom(preview.family, { version: "7.0" }), "again");
    assert.equal(restored.family.people[0].biography, person.biography);
    assert.equal(restored.family.people[0].birthPlace, "Тула");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agelong XML fullname composed only of modeled name parts adds no redundant note", () => {
  const imported = importAgelongXml(
    externalXml("Соколова (Кузнецова) Анна Ивановна ")
      .replace('mn="Ивановна"', 'mn="Ивановна "'),
    "fullname-known",
  );
  assert.equal(imported.family.people[0].biography, "Запись в семейном архиве.");
  assert.ok(!imported.warnings.some((warning) => warning.includes("person.fullname")));
});
