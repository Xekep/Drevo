import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveConnections, replaceConnection } from "../src/domain/connections.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { generationReport } from "../src/domain/generation-report.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { openArchive } from "../src/server/database.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import type { ArchiveUser, Family, Person } from "../src/domain/index.ts";

const person = (id: string): Person => ({ id, name: id, surname: "Test",
  patronymic: "", sex: "u", birth: "", birthPlace: "", parents: [], spouses: [],
  generation: 1, column: 0, sources: [], createdBy: "owner" });
const family = (): Family => ({ title: "Test", description: "", demo: false,
  people: [person("adult"), person("child"), person("other")],
  links: [{ id: "care", from: "adult", to: "child", type: "presumed_parent",
    createdBy: "owner", sources: [{ title: "Interview", type: "oral", reference: "page 1" }] }] });
const actor = (role: ArchiveUser["role"]): ArchiveUser =>
  ({ id: "owner", name: "Owner", role, createdAt: "2026-01-01" });

test("additional relation assessment is a strict enum, never inferred from citation", () => {
  assert.equal(validateFamily(family()).links?.[0].confidence, undefined);
  for (const confidence of ["confirmed", "probable", "tentative", "conflicting", "unknown"] as const) {
    const next = family();
    next.links![0].confidence = confidence;
    assert.equal(validateFamily(next).links?.[0].confidence, confidence);
  }
  const malformed = family();
  Object.assign(malformed.links![0], { confidence: "certain" });
  assert.throws(() => validateFamily(malformed), /дополнительная связь/);
});

test("only assessors change confidence; it cannot follow another relation assertion", () => {
  const before = family();
  const assessed = structuredClone(before);
  assessed.links![0].confidence = "confirmed";
  assert.equal(authorizeArchive(assessed, before, actor("researcher")).links?.[0].confidence,
    "confirmed");
  assert.equal(authorizeArchive(assessed, before, actor("admin")).links?.[0].confidence,
    "confirmed");
  assert.throws(() => authorizeArchive(assessed, before, actor("relative")), /Статус достоверности/);
  for (const field of ["from", "to", "type"] as const) {
    const changed = structuredClone(assessed);
    if (field === "from") changed.links![0].from = "other";
    if (field === "to") changed.links![0].to = "other";
    if (field === "type") changed.links![0].type = "guardian";
    assert.throws(() => authorizeArchive(changed, assessed, actor("admin")), /оценк/);
    changed.links![0].confidence = undefined;
    changed.links![0].sources = [];
    assert.doesNotThrow(() => authorizeArchive(changed, assessed, actor("admin")));
  }
  const removed = structuredClone(assessed);
  removed.links = [];
  assert.throws(() => authorizeArchive(removed, assessed, actor("relative")), /Оценённую связь/);
  const cited = structuredClone(assessed);
  cited.links![0].note = "Checked";
  cited.links![0].sources!.push({ title: "Registry", type: "book", reference: "page 2" });
  assert.equal(authorizeArchive(cited, assessed, actor("relative")).links?.[0].confidence,
    "confirmed", "note and citation changes do not invalidate the relation identity");
  const edge = archiveConnections(assessed).find((item) => item.id === "care")!;
  assert.equal(edge.confidence, "confirmed");
  assert.equal(replaceConnection(assessed, edge, { ...edge, note: "Checked" })
    .links?.[0].confidence, "confirmed");
  assert.equal(replaceConnection(assessed, edge, { ...edge, to: "other" })
    .links?.[0].confidence, undefined);
});

test("additional relation assessment survives SQLite and GEDCOM; scoped sharing needs both people", async () => {
  const data = family();
  data.links![0].confidence = "conflicting";
  const dir = await mkdtemp(join(tmpdir(), "drevo-link-assessment-"));
  const archive = await openArchive(join(dir, "archive.sqlite"), family());
  try {
    await archive.write(data, (await archive.read()).revision);
    assert.equal((await archive.read()).family.links?.[0].confidence, "conflicting");
    const uploads = join(dir, "uploads"), stage = join(dir, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(dir, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: (await archive.read()).family, documents: [], comments: [], sources: [],
    }, async () => {});
    assert.equal((await readPortablePackage(path, stage)).snapshot.family.links?.[0].confidence,
      "conflicting");
  } finally {
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
  for (const version of ["5.5.1", "7.0"] as const)
    assert.equal(importGedcom(exportGedcom(data, { version }), `link-${version}`)
      .family.links?.[0].confidence, "conflicting");
  const exported = exportGedcom(data, { version: "7.0" });
  const malformed = exported.replace("2 _DREVO_LINK_CONFIDENCE conflicting",
    "2 _DREVO_LINK_CONFIDENCE certain");
  assert.notEqual(malformed, exported);
  const recovered = importGedcom(malformed, "invalid-link-assessment");
  assert.equal(recovered.family.links?.[0].confidence, undefined);
  assert.match(recovered.warnings.join(" "), /оценка дополнительной связи/);
  const share = { id: "share", title: "Shared", anchorId: "adult",
    personIds: ["adult", "child"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
    createdBy: "owner", createdName: "Owner", revokedAt: null, lastVisitedAt: null };
  assert.equal(sharedFamily(data, share, "token").links?.[0].confidence, "conflicting");
  assert.deepEqual(sharedFamily(data, { ...share, personIds: ["adult"] }, "token").links, []);
  assert.match(generationReport(data, new Set(["adult", "child"])), /Оценка связи: Противоречиво/);
});
