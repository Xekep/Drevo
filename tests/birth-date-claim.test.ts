import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/server/database.ts";
import { startServer } from "../src/server/index.ts";
import { archiveChanges } from "../src/domain/changes.ts";
import { sourceCatalogStore, allCitations } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";

const source: CatalogSource = {
  id: "birth-register", title: "Метрическая книга", type: "архивная запись",
  author: "", institution: "", archive: "ГАСО", fond: "6", opis: "13",
  delo: "104", sheet: "12", reference: "л. 12", url: "", accessedAt: "",
  description: "", documentIds: [],
};
const family = (): Family => ({
  title: "Родословная", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", birthPlace: "Тула", parents: [], spouses: [],
    generation: 1, column: 0, sources: [], createdBy: "admin" }],
});

test("a birth-date citation stays bound to its value, archive and portable exports", async () => {
  const archive = await openArchive(":memory:", family());
  const directory = await mkdtemp(join(tmpdir(), "drevo-birth-claim-"));
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const next = (await archive.read()).family;
    next.people[0].birthDateClaim = { value: "1880", sources: [sourceCitation(source)] };
    await archive.write(next, (await archive.read()).revision);
    const stored = (await archive.read()).family;
    assert.equal(stored.people[0].birthDateClaim?.sources[0].catalogId, source.id);
    assert.equal(allCitations(stored).length, 1);

    const changed = structuredClone(stored);
    changed.people[0].birth = "1881";
    assert.throws(() => validateFamily(changed), /прежней|другому значению/);
    await assert.rejects(archive.write(changed, (await archive.read()).revision), /другому значению/);
    const emptyCitation = structuredClone(stored);
    emptyCitation.people[0].birthDateClaim!.sources = [{ title: "", type: "", reference: "" }];
    assert.throws(() => validateFamily(emptyCitation), /Источник даты рождения/);
    const foreign = structuredClone(stored);
    foreign.people[0].birthDateClaim!.sources[0].catalogId = "foreign-source";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision), /Источник отсутствует/);

    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Исправленная книга" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.people[0].birthDateClaim?.sources[0].title,
      "Исправленная книга");

    const gedcom = exportGedcom((await archive.read()).family, { version: "7.0" });
    assert.match(gedcom, /3 _DREVO_CLAIM BIRTH_DATE/);
    const imported = importGedcom(gedcom, "other-archive").family.people[0];
    assert.equal(imported.birthDateClaim?.value, "1880");
    assert.equal(imported.birthDateClaim?.sources[0].title, "Исправленная книга");
    assert.equal(imported.birthDateClaim?.sources[0].catalogId, undefined);
    assert.equal(imported.sources.length, 0);
    const ordinaryGedcom = gedcom
      .replace("3 _DREVO_CLAIM BIRTH_DATE\r\n", "")
      .replace(/^1 _DREVO .+\r\n/m, "");
    const ordinaryBirthSource = importGedcom(ordinaryGedcom, "ordinary").family.people[0];
    assert.equal(ordinaryBirthSource.birthDateClaim, undefined);
    assert.equal(ordinaryBirthSource.sources[0].title, "Исправленная книга");
    const missingDate = gedcom.replace(/^2 DATE .+\r\n/m, "")
      .replace(/^1 _DREVO .+\r\n/m, "");
    const unsupportedClaim = importGedcom(missingDate, "missing-date").family.people[0];
    assert.equal(unsupportedClaim.birthDateClaim, undefined);
    assert.equal(unsupportedClaim.sources[0].title, "Исправленная книга");

    const packagePath = join(directory, "family.drevo");
    const uploads = join(directory, "uploads");
    const stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    await writePortablePackage(createWriteStream(packagePath), uploads, {
      family: (await archive.read()).family, documents: [], comments: [], sources: [source],
    }, async () => {});
    const packageData = await readPortablePackage(packagePath, stage);
    assert.equal(packageData.snapshot.family.people[0].birthDateClaim?.sources[0].catalogId,
      source.id);
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an editor cannot attach a birth-date citation to another author's person", () => {
  const current = family();
  const next = structuredClone(current);
  next.people[0].birthDateClaim = { value: "1880", sources: [sourceCitation(source)] };
  const editor: ArchiveUser = {
    id: "editor", name: "Редактор", role: "researcher", createdAt: "2026-01-01",
  };
  assert.throws(() => authorizeArchive(next, current, editor), /только свои карточки/);
});

test("archive changes save the birth-date claim through HTTP and reject a stale value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-birth-http-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    await sourceCatalogStore(app.archive.db).insert(source);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    next.people[0].birthDateClaim = { value: "1880", sources: [sourceCitation(source)] };
    const post = (changes: ReturnType<typeof archiveChanges>, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes }) });
    const saved = await post(archiveChanges(before.family, next), before.revision);
    assert.equal(saved.status, 200);
    assert.equal((await app.archive.read()).family.people[0].birthDateClaim?.sources[0].catalogId,
      source.id);
    const after = await app.archive.read();
    const changed = structuredClone(after.family);
    changed.people[0].birth = "1881";
    const rejected = await post(archiveChanges(after.family, changed), after.revision);
    assert.equal(rejected.status, 400);
    assert.equal((await app.archive.read()).family.people[0].birth, "1880");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
