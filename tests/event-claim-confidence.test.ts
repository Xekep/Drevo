import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { generationReport } from "../src/domain/generation-report.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";

const source = { title: "Метрическая книга", type: "архив", reference: "л. 7" };
const user = (role: ArchiveUser["role"]): ArchiveUser => ({
  id: "owner", name: "Владелец", role, createdAt: "2026-01-01",
});
const family = (): Family => ({ title: "Семья", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", birthPlace: "Тула", parents: [], spouses: [],
    generation: 1, column: 0, sources: [], createdBy: "owner",
    events: [{ id: "move", type: "move", date: "1901", place: "Москва",
      dateClaim: { value: "1901", sources: [source] },
      placeClaim: { value: "Москва", sources: [source] } }] }],
});
const assessed = (): Family => {
  const value = family();
  value.people[0].events![0].dateClaim!.confidence = "probable";
  value.people[0].events![0].placeClaim!.confidence = "conflicting";
  return value;
};

test("event assessments require cited exact values and researcher rights", () => {
  const before = family(), next = assessed();
  assert.doesNotThrow(() => validateFamily(next));
  assert.throws(() => authorizeArchive(next, before, user("relative")),
    /Статус достоверности/);
  assert.equal(authorizeArchive(next, before, user("researcher"))
    .people[0].events?.[0].dateClaim?.confidence, "probable");
  assert.equal(authorizeArchive(next, before, user("admin"))
    .people[0].events?.[0].placeClaim?.confidence, "conflicting");
  const editedCitation = structuredClone(next);
  editedCitation.people[0].events![0].dateClaim!.sources.push({ ...source, reference: "л. 8" });
  assert.equal(authorizeArchive(editedCitation, next, user("relative"))
    .people[0].events?.[0].dateClaim?.sources.length, 2);
  const erased = structuredClone(next);
  erased.people[0].events![0].dateClaim = undefined;
  assert.throws(() => authorizeArchive(erased, next, user("relative")),
    /Оценённое утверждение/);
  const deletedEvent = structuredClone(next);
  deletedEvent.people[0].events = [];
  assert.throws(() => authorizeArchive(deletedEvent, next, user("relative")),
    /Оценённое утверждение/);
  const deletedPerson = structuredClone(next);
  deletedPerson.people = [];
  assert.throws(() => authorizeArchive(deletedPerson, next, user("relative")),
    /Оценённую карточку/);
  const changedMeaning = structuredClone(next);
  changedMeaning.people[0].events![0].type = "marriage";
  assert.throws(() => authorizeArchive(changedMeaning, next, user("relative")),
    /Оценённое утверждение/);
  const changed = structuredClone(next);
  changed.people[0].events![0].place = "Казань";
  changed.people[0].events![0].placeClaim = {
    value: "Казань", sources: [source], confidence: "conflicting",
  };
  assert.throws(() => authorizeArchive(changed, next, user("relative")),
    /Оценённое утверждение/);
  const invalid = structuredClone(next);
  Object.assign(invalid.people[0].events![0].dateClaim!, { confidence: "certain" });
  assert.throws(() => validateFamily(invalid), /Источник даты события/);
  const uncited = structuredClone(next);
  uncited.people[0].events![0].dateClaim!.sources = [];
  assert.throws(() => validateFamily(uncited), /Источник даты события/);
});

test("event assessments survive .drevo and GEDCOM without becoming general evidence", async () => {
  const value = assessed();
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-assessment-"));
  try {
    const path = join(directory, "family.drevo"), stage = join(directory, "stage");
    await mkdir(stage);
    await writePortablePackage(createWriteStream(path), join(directory, "uploads"), {
      family: value, documents: [], comments: [], sources: [],
    }, async () => {});
    const portable = await readPortablePackage(path, stage);
    const event = portable.snapshot.family.people[0].events![0];
    assert.equal(event.dateClaim?.confidence, "probable");
    assert.equal(event.placeClaim?.confidence, "conflicting");
    for (const version of ["5.5.1", "7.0"] as const) {
      const output = exportGedcom(value, { version });
      assert.match(output, /2 _DREVO_EVENT_DATE_CONFIDENCE probable/);
      assert.match(output, /2 _DREVO_EVENT_PLACE_CONFIDENCE conflicting/);
      const imported = importGedcom(output, `assessment-${version}`).family.people[0]
        .events!.find((item) => item.id === "move")!;
      assert.equal(imported.dateClaim?.confidence, "probable");
      assert.equal(imported.placeClaim?.confidence, "conflicting");
      assert.ok(!imported.sources?.length);
      const external = output.replace(/^1 _DREVO .+\r\n/m, "");
      const standalone = importGedcom(external, `external-${version}`).family.people[0]
        .events!.find((item) => item.type === "move")!;
      assert.equal(standalone.dateClaim?.confidence, "probable");
      assert.equal(standalone.placeClaim?.confidence, "conflicting");
    }
    const shared = sharedFamily(value, { id: "share", title: "Фрагмент",
      anchorId: "anna", personIds: ["anna"], createdAt: "2026-01-01",
      expiresAt: "2027-01-01", createdBy: "owner", createdName: "Владелец",
      revokedAt: null, lastVisitedAt: null }, "token");
    assert.equal(shared.people[0].events?.[0].dateClaim?.confidence, "probable");
    assert.match(generationReport(value, new Set(["anna"])), /Оценка даты события.*Вероятно/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
