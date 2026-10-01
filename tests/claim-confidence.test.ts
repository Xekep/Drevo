import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChanges } from "../src/domain/changes.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { startServer } from "../src/server/index.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import type { ArchiveUser, ClaimConfidence, Family, PersonValueClaim } from "../src/domain/index.ts";

const citation = { title: "Метрическая книга", type: "архивная запись", reference: "ф. 6, д. 104" };
const family = (): Family => ({ title: "Родословная", description: "", demo: false, people: [{
  id: "anna", name: "Анна", surname: "Тестова", patronymic: "", sex: "f",
  birth: "1880", death: "1950", birthPlace: "Тула", deathPlace: "Казань",
  parents: [], spouses: [], generation: 1, column: 0, sources: [], createdBy: "researcher",
}] });
const user = (id: string, role: ArchiveUser["role"]): ArchiveUser =>
  ({ id, name: id, role, createdAt: "2026-01-01" });
function assessed(): Family {
  const value = family();
  const person = value.people[0];
  const claim = (field: string, confidence: ClaimConfidence): PersonValueClaim =>
    ({ value: field, sources: [{ ...citation }], confidence });
  person.birthDateClaim = claim(person.birth, "confirmed");
  person.deathDateClaim = claim(person.death!, "probable");
  person.birthPlaceClaim = claim(person.birthPlace, "tentative");
  person.deathPlaceClaim = claim(person.deathPlace!, "conflicting");
  return value;
}

test("claim confidence is explicit, bounded to the cited value, and has a strict enum", () => {
  const value = assessed();
  assert.doesNotThrow(() => validateFamily(value));
  const old = family();
  old.people[0].birthDateClaim = { value: "1880", sources: [{ ...citation }] };
  assert.equal(validateFamily(old).people[0].birthDateClaim?.confidence, undefined,
    "adding a source never promotes an unassessed fact");
  for (const confidence of ["confirmed", "probable", "tentative", "conflicting", "unknown"] as const) {
    const next = assessed();
    next.people[0].birthPlaceClaim!.confidence = confidence;
    assert.doesNotThrow(() => validateFamily(next));
  }
  const invalid = assessed();
  Object.assign(invalid.people[0].birthPlaceClaim!, { confidence: "certain" });
  assert.throws(() => validateFamily(invalid), /Источник места рождения/);
  const changed = assessed();
  changed.people[0].birthPlace = "Другая Тула";
  assert.throws(() => validateFamily(changed), /Источник места рождения/);
});

test("only an owning researcher or administrator may assess an existing claim", () => {
  const before = family();
  before.people[0].birthDateClaim = { value: "1880", sources: [{ ...citation }] };
  const next = structuredClone(before);
  next.people[0].birthDateClaim!.confidence = "confirmed";
  assert.equal(authorizeArchive(next, before, user("researcher", "researcher"))
    .people[0].birthDateClaim?.confidence, "confirmed");
  assert.equal(authorizeArchive(next, before, user("admin", "admin"))
    .people[0].birthDateClaim?.confidence, "confirmed");
  assert.throws(() => authorizeArchive(next, before, user("researcher", "relative")),
    /Статус достоверности/);
  assert.throws(() => authorizeArchive(next, before, user("other", "researcher")),
    /только свои карточки/);
  const unassessed = structuredClone(before);
  unassessed.people[0].birthDateClaim!.sources.push({ ...citation, reference: "л. 8" });
  assert.equal(authorizeArchive(unassessed, before, user("researcher", "relative"))
    .people[0].birthDateClaim?.confidence, undefined,
    "a relative can still edit a source on their own card without assessing it");
});

test(".drevo and GEDCOM 5.5.1/7 preserve all four manual assessments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-confidence-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const portablePath = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(portablePath), uploads, {
      family: assessed(), documents: [], comments: [], sources: [],
    }, async () => {});
    const portable = await readPortablePackage(portablePath, stage);
    const person = portable.snapshot.family.people[0];
    assert.deepEqual([
      person.birthDateClaim?.confidence, person.deathDateClaim?.confidence,
      person.birthPlaceClaim?.confidence, person.deathPlaceClaim?.confidence,
    ], ["confirmed", "probable", "tentative", "conflicting"]);

    for (const version of ["5.5.1", "7.0"] as const) {
      const output = exportGedcom(assessed(), { version });
      assert.match(output, /2 _DREVO_DATE_CONFIDENCE confirmed/);
      assert.match(output, /2 _DREVO_PLACE_CONFIDENCE conflicting/);
      const imported = importGedcom(output, `confidence-${version}`).family.people[0];
      assert.deepEqual([
        imported.birthDateClaim?.confidence, imported.deathDateClaim?.confidence,
        imported.birthPlaceClaim?.confidence, imported.deathPlaceClaim?.confidence,
      ], ["confirmed", "probable", "tentative", "conflicting"]);
      const legacy = family();
      legacy.people[0].birthDateClaim = { value: "1880", sources: [{ ...citation }] };
      const noAssessment = importGedcom(exportGedcom(legacy, { version }), `old-${version}`)
        .family.people[0];
      assert.equal(noAssessment.birthDateClaim?.confidence, undefined);
      assert.equal(Object.hasOwn(noAssessment.birthDateClaim!, "confidence"), false);
      const malformed = importGedcom(output.replace("_DREVO_DATE_CONFIDENCE confirmed",
        "_DREVO_DATE_CONFIDENCE certainly"), `malformed-${version}`).family.people[0];
      assert.equal(malformed.birthDateClaim?.confidence, undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP writes persist assessment and reject a silent value change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-confidence-http-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    next.people[0].birthDateClaim = { value: "1880", sources: [{ ...citation }], confidence: "unknown" };
    const post = (previous: Family, candidate: Family, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes: archiveChanges(previous, candidate) }) });
    assert.equal((await post(before.family, next, before.revision)).status, 200);
    const saved = await app.archive.read();
    assert.equal(saved.family.people[0].birthDateClaim?.confidence, "unknown");
    const changed = structuredClone(saved.family);
    changed.people[0].birth = "1881";
    assert.equal((await post(saved.family, changed, saved.revision)).status, 400);
    assert.equal((await app.archive.read()).family.people[0].birth, "1880");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
