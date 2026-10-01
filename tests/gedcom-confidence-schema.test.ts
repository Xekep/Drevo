import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { Family } from "../src/domain/types.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";

const source = { title: "Метрическая книга", type: "архив", reference: "л. 7" };
const family = (): Family => ({
  title: "Родословная", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Петрова", patronymic: "",
    sex: "f", birth: "1900", birthPlace: "Тула", death: "1980", deathPlace: "Казань",
    occupation: "Учитель", maidenName: "Иванова", parents: [], spouses: [],
    generation: 1, column: 0, sources: [],
    birthDateClaim: { value: "1900", sources: [source], confidence: "probable" },
    deathDateClaim: { value: "1980", sources: [source], confidence: "confirmed" },
    birthPlaceClaim: { value: "Тула", sources: [source], confidence: "tentative" },
    deathPlaceClaim: { value: "Казань", sources: [source], confidence: "conflicting" },
    occupationClaim: { value: "Учитель", sources: [source], confidence: "unknown" },
    maidenNameClaim: { value: "Иванова", sources: [source], confidence: "probable" },
  }],
});

const confidenceTags = [
  "_DREVO_DATE_CONFIDENCE", "_DREVO_PLACE_CONFIDENCE",
  "_DREVO_OCCUPATION_CONFIDENCE", "_DREVO_BIRTH_SURNAME_CONFIDENCE",
];
function assertClaims(imported: Family) {
  const person = imported.people[0];
  assert.equal(person.birthDateClaim?.confidence, "probable");
  assert.equal(person.deathDateClaim?.confidence, "confirmed");
  assert.equal(person.birthPlaceClaim?.confidence, "tentative");
  assert.equal(person.deathPlaceClaim?.confidence, "conflicting");
  assert.equal(person.occupationClaim?.confidence, "unknown");
  assert.equal(person.maidenNameClaim?.confidence, "probable");
  for (const claim of [person.birthDateClaim, person.deathDateClaim,
    person.birthPlaceClaim, person.deathPlaceClaim, person.occupationClaim,
    person.maidenNameClaim])
    assert.equal(claim?.sources[0].reference, "л. 7");
}

test("own GEDCOM confidence tags round trip without a false data-loss warning", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom(family(), { version });
    if (version === "7.0")
      for (const tag of confidenceTags)
        assert.ok(text.includes(`2 TAG ${tag} https://drevo.kiiko.ru/gedcom/extensions/${tag.slice(1).toLowerCase()}`));
    const imported = importGedcom(text, `confidence-${version}`);
    assertClaims(imported.family);
    for (const tag of confidenceTags)
      assert.ok(!imported.warnings.some((warning) => warning.includes(`Поле ${tag} не перенесено`)),
        `${version}: ${tag} is understood by the importer`);

    const unknown = importGedcom(text.replace("2 _DREVO_OCCUPATION_CONFIDENCE unknown",
      "2 _DREVO_OCCUPATION_CONFIDENCE unknown\r\n2 _OTHER_CONFIDENCE Y"), `unknown-${version}`);
    assert.ok(unknown.warnings.some((warning) => warning.includes("Поле _OTHER_CONFIDENCE не перенесено")));
  }
});

test("GEDZIP and .drevo retain assessments without a false GEDCOM warning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedcom-confidence-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const archive = family();
    const gedzip = join(directory, "family.gdz");
    await writeGenealogyPackage(gedzip, uploads, archive, []);
    const imported = await prepareGenealogyImport(gedzip, stage, "confidence-gedzip");
    assertClaims(imported.family);
    for (const tag of confidenceTags)
      assert.ok(!imported.warnings.some((warning) => warning.includes(`Поле ${tag} не перенесено`)));

    const portablePath = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(portablePath), uploads, {
      family: archive, documents: [], comments: [], sources: [],
    }, async () => {});
    const portable = await readPortablePackage(portablePath, stage);
    assertClaims(portable.snapshot.family);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
