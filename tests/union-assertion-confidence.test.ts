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

const citation = { title: "Marriage register", type: "book", reference: "folio 3" };
const actor = (role: ArchiveUser["role"]): ArchiveUser =>
  ({ id: "owner", name: "Owner", role, createdAt: "2026-01-01" });
const family = (): Family => ({
  title: "Test", description: "", demo: false,
  people: ["a", "b", "c"].map((id) => ({
    id, name: id, surname: "Test", patronymic: "", sex: "u" as const,
    birth: "1900", birthPlace: "", parents: [],
    spouses: id === "a" ? ["b", "c"] : ["a"],
    generation: 1, column: 0, sources: [], createdBy: "owner",
  })),
  unions: [{ id: "union", participants: ["a", "b"], type: "marriage", createdBy: "owner",
    sources: [citation], formation: { date: "1920", confidence: "probable" } }],
});

test("union-wide confidence is a strict manual enum independent of cited stages", () => {
  const before = family();
  assert.equal(validateFamily(before).unions![0].confidence, undefined,
    "union citations and stage assessment must not promote the union itself");
  for (const status of ["confirmed", "probable", "tentative", "conflicting", "unknown"] as const) {
    const next = family();
    next.unions![0].confidence = status;
    assert.equal(validateFamily(next).unions![0].confidence, status);
  }
  const invalid = family();
  Object.assign(invalid.unions![0], { confidence: "certain" });
  assert.throws(() => validateFamily(invalid), /союз/);
});

test("union assessment is researcher-only and cannot follow a different union assertion", () => {
  const before = family();
  const assessed = structuredClone(before);
  assessed.unions![0].confidence = "confirmed";
  assert.equal(authorizeArchive(assessed, before, actor("researcher"))
    .unions![0].confidence, "confirmed");
  assert.equal(authorizeArchive(assessed, before, actor("admin"))
    .unions![0].confidence, "confirmed");
  assert.throws(() => authorizeArchive(assessed, before, actor("relative")), /Статус достоверности/);
  const changedType = structuredClone(assessed);
  changedType.unions![0].type = "partnership";
  assert.throws(() => authorizeArchive(changedType, assessed, actor("admin")), /оценк/);
  const changedPeople = structuredClone(assessed);
  changedPeople.unions![0].participants = ["a", "c"];
  assert.throws(() => authorizeArchive(changedPeople, assessed, actor("admin")), /оценк/);
  const removed = structuredClone(assessed);
  removed.unions = [];
  assert.throws(() => authorizeArchive(removed, assessed, actor("relative")), /Оценённый союз/);
  const cleared = structuredClone(changedType);
  delete cleared.unions![0].confidence;
  cleared.unions![0].sources = undefined;
  cleared.unions![0].formation = undefined;
  assert.equal(authorizeArchive(cleared, assessed, actor("admin"))
    .unions![0].confidence, undefined);
  const note = structuredClone(assessed);
  note.unions![0].note = "Verified spelling";
  note.unions![0].sources!.push({ ...citation, reference: "folio 4" });
  assert.equal(authorizeArchive(note, assessed, actor("relative"))
    .unions![0].confidence, "confirmed", "citation and note edits do not change the assertion");
});

test("union-wide assessment survives GEDCOM and is visible only with both shared participants", () => {
  const data = family();
  data.unions![0].confidence = "conflicting";
  for (const version of ["5.5.1", "7.0"] as const)
    assert.equal(importGedcom(exportGedcom(data, { version }), `union-${version}`)
      .family.unions?.[0].confidence, "conflicting");
  const share = { id: "share", title: "Shared", anchorId: "a",
    personIds: ["a", "b"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
    createdBy: "owner", createdName: "Owner", revokedAt: null, lastVisitedAt: null };
  assert.equal(sharedFamily(data, share, "token").unions?.[0].confidence, "conflicting");
  assert.deepEqual(sharedFamily(data, { ...share, personIds: ["a"] }, "token").unions, []);
  assert.match(generationReport(data, new Set(["a", "b"])), /Противоречиво/);
});

test("invalid Drevo union assessment warns without discarding the imported family", () => {
  const data = family();
  data.unions![0] = { id: "union", participants: ["a", "b"],
    type: "marriage", confidence: "confirmed" };
  const exported = exportGedcom(data, { version: "7.0" });
  const malformed = exported.replace('"confidence":"confirmed"', '"confidence":"certain"');
  assert.notEqual(malformed, exported);
  const imported = importGedcom(malformed, "invalid-union-status");
  assert.equal(imported.family.unions?.[0].confidence, undefined);
  assert.match(imported.warnings.join(" "), /оценк.*союз/);
});

test("HTTP/SQLite and portable archive preserve the union-wide assessment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-union-assertion-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const initial = await app.archive.read();
    const seeded = await app.archive.write(family(), initial.revision);
    const next = structuredClone(seeded.family);
    next.unions![0].confidence = "tentative";
    const response = await fetch(`${base}/api/family`, {
      method: "PUT", headers: { Origin: base, "Content-Type": "application/json",
        "If-Match": String(seeded.revision) }, body: JSON.stringify(next),
    });
    assert.equal(response.status, 200, await response.text());
    const stored = await app.archive.read();
    assert.equal(stored.family.unions?.[0].confidence, "tentative");
    const uploads = join(dir, "uploads"), stage = join(dir, "stage");
    await mkdir(uploads, { recursive: true });
    await mkdir(stage, { recursive: true });
    const path = join(dir, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: stored.family, documents: [], comments: [], sources: [],
    }, async () => {});
    const restored = await readPortablePackage(path, stage);
    assert.equal(restored.snapshot.family.unions?.[0].confidence, "tentative");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
