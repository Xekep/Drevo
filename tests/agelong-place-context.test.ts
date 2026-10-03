import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAgelongXml } from "../src/domain/agelong-xml.ts";
import { importGedcom, exportGedcom } from "../src/domain/gedcom.ts";
import { familyMedia } from "../src/domain/genealogy-transfer.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";

// Anonymized subset of the supplied Agelong export's actual place structure:
// a referenced historical place, parent_id ancestry, and person/event links.
const xml = `<agelongtree lang="ru" dateformat="DD.MM.YYYY">
  <persons>
    <person id="a" fn="Anna" sn="Example" bdate="1900">
      <bplace id="town">Тестовый город</bplace>
      <place id="town">Тестовый город</place>
      <sources><source id="register" page="7"/></sources>
    </person>
    <person id="b" fn="Boris" sn="Example"/>
  </persons>
  <events>
    <event id="wedding" type="Свадьба" date="1920">
      <place id="town">Тестовый город</place>
      <persons><person id="a" role="Жена"/><person id="b" role="Муж"/></persons>
    </event>
    <event id="journey" type="Поездка" date="1921">
      <place id="town">Тестовый город</place>
      <persons><person id="a" role="Участник"/></persons>
      <sources><source id="register"/></sources>
    </event>
  </events>
  <places>
    <place id="town" fullname="Тестовый город" name="Тестовый город" nameshort="Город" date="1812">
      <parent_id id="district"/>
    </place>
    <place id="district" fullname="Тестовый уезд" name="Тестовый уезд" nameshort="Уезд">
      <parent_id id="region"/>
    </place>
    <place id="region" fullname="Тестовая губерния" name="Тестовая губерния" nameshort="Губерния" date="1708"/>
  </places>
  <sources><source id="register" title="Тестовый реестр" reference="лист 7"/></sources>
</agelongtree>`;

test("Agelong place ancestry and dated names remain with linked facts through GEDCOM 7", () => {
  const first = importAgelongXml(xml, "place-xml");
  const anna = first.family.people[0];
  const wedding = anna.events?.find((event) => event.title === "Свадьба");
  const journey = anna.events?.find((event) => event.title === "Поездка");
  const residence = anna.events?.find((event) => event.type === "residence");
  assert.equal(anna.birthPlace, "Тестовый город");
  assert.equal(first.family.unions?.[0].formation?.place, "Тестовый город");
  assert.equal(anna.sources[0].title, "Тестовый реестр");
  assert.equal(journey?.sources?.[0].reference, "лист 7");
  for (const detail of [anna.biography, wedding?.description, journey?.description, residence?.description]) {
    assert.match(detail || "", /Тестовый уезд/);
    assert.match(detail || "", /Тестовая губерния/);
    assert.match(detail || "", /1812/);
    assert.match(detail || "", /1708/);
  }
  assert.ok(first.warnings.some((warning) => /Иерархия родительских мест/.test(warning) && /текстом/.test(warning)));
  assert.ok(first.warnings.some((warning) => /Даты исторических названий мест/.test(warning) && /текстом/.test(warning)));

  const restored = importGedcom(exportGedcom(first.family, { version: "7.0" }), "place-gedcom").family;
  const back = restored.people[0];
  assert.equal(back.biography, anna.biography);
  assert.equal(back.events?.find((event) => event.title === "Свадьба")?.description, wedding?.description);
  assert.equal(back.events?.find((event) => event.title === "Поездка")?.description, journey?.description);
  assert.equal(back.events?.find((event) => event.type === "residence")?.description, residence?.description);
  assert.equal(back.sources[0].title, "Тестовый реестр");
  assert.equal(back.events?.find((event) => event.title === "Поездка")?.sources?.[0].reference, "лист 7");
});

test("supplied Agelong archive keeps its complete media and place context through GEDZIP", {
  skip: !process.env.DREVO_AGELONG_SAMPLE_ZIP,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-agelong-real-sample-"));
  try {
    const sourceStage = join(directory, "xml");
    const targetStage = join(directory, "gedzip");
    await Promise.all([mkdir(sourceStage), mkdir(targetStage)]);
    const source = await prepareGenealogyImport(
      process.env.DREVO_AGELONG_SAMPLE_ZIP!, sourceStage, "real-xml",
    );
    const gedzip = join(directory, "roundtrip.gdz");
    await writeGenealogyPackage(gedzip, sourceStage, source.family, familyMedia(source.family));
    const restored = await prepareGenealogyImport(gedzip, targetStage, "real-gedzip");
    const counts = (family: typeof source.family) => ({
      people: family.people.length,
      parents: family.people.reduce((count, person) => count + person.parents.length, 0),
      events: family.people.reduce((count, person) => count + (person.events?.length || 0), 0),
      unions: family.unions?.length,
      photos: family.photos?.length,
      portraits: family.people.filter((person) => person.photo).length,
    });
    assert.deepEqual(counts(source.family), {
      people: 53, parents: 74, events: 123, unions: 15, photos: 18, portraits: 17,
    });
    assert.deepEqual(counts(restored.family), counts(source.family));
    assert.equal(source.files.length, 18);
    assert.equal(restored.files.length, 18);
    const hashes = async (stage: string, files: typeof source.files) =>
      (await Promise.all(files.map(async (file) => createHash("sha256")
        .update(await readFile(join(stage, file.name))).digest("hex")))).sort();
    assert.deepEqual(await hashes(sourceStage, source.files), await hashes(targetStage, restored.files));
    assert.deepEqual(
      restored.family.people.map((person) => person.biography),
      source.family.people.map((person) => person.biography),
    );
    assert.deepEqual(
      restored.family.people.map((person) => person.events?.map((event) => event.description)),
      source.family.people.map((person) => person.events?.map((event) => event.description)),
    );
    assert.ok(source.family.people.some((person) => person.biography?.includes("Контекст места")));
    assert.ok(source.warnings.some((warning) => warning.includes("Иерархия родительских мест (20)")));
    assert.ok(source.warnings.some((warning) => warning.includes("Даты исторических названий мест (2)")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
