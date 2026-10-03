import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeArchive } from "../src/server/permissions.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { generationReport } from "../src/domain/generation-report.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { startServer } from "../src/server/index.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";

const user = (role: ArchiveUser["role"]): ArchiveUser =>
  ({ id: "owner", name: "Owner", role, createdAt: "2026-01-01" });
const family = (): Family => ({
  title: "Test", description: "", demo: false,
  people: ["a", "b"].map((id) => ({
    id, name: id, surname: "Test", patronymic: "", sex: "u" as const,
    birth: "1900", birthPlace: "", parents: [], spouses: [id === "a" ? "b" : "a"],
    generation: 1, column: 0, sources: [], createdBy: "owner",
  })),
  unions: [{ id: "union", participants: ["a", "b"], type: "marriage", createdBy: "owner",
    formation: { date: "1920", place: "Moscow", sources: [{ title: "Register", type: "book", reference: "3" }] },
    divorce: { date: "1940", sources: [] } }],
});

test("union milestone assessments are validated and cannot be inferred from citations", () => {
  const before = family();
  assert.equal(validateFamily(before).unions![0].formation?.confidence, undefined);
  for (const status of ["confirmed", "probable", "tentative", "conflicting", "unknown"] as const) {
    const next = family();
    next.unions![0].formation!.confidence = status;
    assert.equal(validateFamily(next).unions![0].formation?.confidence, status);
  }
  const invalid = family();
  Object.assign(invalid.unions![0].formation!, { confidence: "certain" });
  assert.throws(() => validateFamily(invalid), /союз/);
});

test("only a researcher or administrator can assess a union milestone; edits cannot inherit an assessment", () => {
  const before = family();
  const assessed = structuredClone(before);
  assessed.unions![0].formation!.confidence = "probable";
  assert.equal(authorizeArchive(assessed, before, user("researcher"))
    .unions![0].formation?.confidence, "probable");
  assert.equal(authorizeArchive(assessed, before, user("admin"))
    .unions![0].formation?.confidence, "probable");
  assert.throws(() => authorizeArchive(assessed, before, user("relative")), /Статус достоверности/);
  const changedDate = structuredClone(assessed);
  changedDate.unions![0].formation!.date = "1921";
  assert.throws(() => authorizeArchive(changedDate, assessed, user("researcher")), /оценк/);
  const changedPlace = structuredClone(assessed);
  changedPlace.unions![0].formation!.place = "Kazan";
  assert.throws(() => authorizeArchive(changedPlace, assessed, user("admin")), /оценк/);
  const changedType = structuredClone(assessed);
  changedType.unions![0].type = "partnership";
  changedType.unions![0].divorce = undefined;
  assert.throws(() => authorizeArchive(changedType, assessed, user("admin")), /оценк/);
  const transferred = structuredClone(changedType);
  delete transferred.unions![0].formation!.confidence;
  transferred.unions![0].ongoing = { date: "1930", confidence: "probable" };
  assert.throws(() => authorizeArchive(transferred, assessed, user("admin")), /оценк/);
  const cleared = structuredClone(changedDate);
  delete cleared.unions![0].formation!.confidence;
  assert.equal(authorizeArchive(cleared, assessed, user("researcher"))
    .unions![0].formation?.confidence, undefined);
  assert.throws(() => authorizeArchive(cleared, assessed, user("relative")), /Статус достоверности/);
  const removed = structuredClone(assessed);
  removed.unions = [];
  assert.throws(() => authorizeArchive(removed, assessed, user("relative")), /Оценённый союз/);
  const newEvidence = structuredClone(assessed);
  newEvidence.unions![0].formation!.sources!.push({ title: "Witness", type: "oral", reference: "2" });
  assert.equal(authorizeArchive(newEvidence, assessed, user("relative"))
    .unions![0].formation?.sources?.length, 2);
});

test("union milestone confidence survives GEDCOM and is shown in public projection and report", () => {
  const data = family();
  data.unions![0].formation!.confidence = "probable";
  data.unions![0].divorce!.confidence = "conflicting";
  for (const version of ["5.5.1", "7.0"] as const) {
    const restored = importGedcom(exportGedcom(data, { version }), `confidence-${version}`).family;
    assert.equal(restored.unions?.[0].formation?.confidence, "probable");
    assert.equal(restored.unions?.[0].divorce?.confidence, "conflicting");
  }
  const projected = sharedFamily(data, {
    id: "share", title: "Shared", anchorId: "a", personIds: ["a", "b"],
    createdAt: "2026-01-01", expiresAt: "2027-01-01", createdBy: "owner",
    createdName: "Owner", revokedAt: null, lastVisitedAt: null,
  }, "token");
  assert.equal(projected.unions?.[0].formation?.confidence, "probable");
  assert.equal(projected.unions?.[0].divorce?.confidence, "conflicting");
  const hidden = sharedFamily(data, {
    id: "partial", title: "Partial", anchorId: "a", personIds: ["a"],
    createdAt: "2026-01-01", expiresAt: "2027-01-01", createdBy: "owner",
    createdName: "Owner", revokedAt: null, lastVisitedAt: null,
  }, "token");
  assert.deepEqual(hidden.unions, []);
  const report = generationReport(data, new Set(["a", "b"]));
  assert.match(report, /Вероятно/);
  assert.match(report, /Противоречиво/);
});

test("HTTP save persists the assessment in the archive and rejects malformed status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-union-confidence-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const initial = await app.archive.read();
    const seeded = await app.archive.write(family(), initial.revision);
    const data = structuredClone(seeded.family);
    data.unions![0].formation!.confidence = "confirmed";
    const put = (body: Family, revision: number) => fetch(`${base}/api/family`, {
      method: "PUT", headers: { Origin: base, "Content-Type": "application/json",
        "If-Match": String(revision) }, body: JSON.stringify(body),
    });
    const response = await put(data, seeded.revision);
    assert.equal(response.status, 200, await response.text());
    const stored = await app.archive.read();
    assert.equal(stored.family.unions?.[0].formation?.confidence, "confirmed");
    const invalid = structuredClone(stored.family);
    Object.assign(invalid.unions![0].formation!, { confidence: "certain" });
    const rejected = await put(invalid, stored.revision);
    assert.equal(rejected.status, 400);
    assert.equal((await app.archive.read()).revision, stored.revision);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("portable archive round-trip preserves assessments of separate union stages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-union-portable-"));
  try {
    const uploads = join(dir, "uploads"), stage = join(dir, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const data = family();
    data.unions![0].formation!.confidence = "tentative";
    data.unions![0].divorce!.confidence = "unknown";
    const path = join(dir, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: data, documents: [], comments: [], sources: [],
    }, async () => {});
    const restored = await readPortablePackage(path, stage);
    assert.equal(restored.snapshot.family.unions?.[0].formation?.confidence, "tentative");
    assert.equal(restored.snapshot.family.unions?.[0].divorce?.confidence, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
