import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChanges } from "../src/domain/changes.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { openArchive } from "../src/server/database.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { startServer } from "../src/server/index.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { allCitations, sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";

const source: CatalogSource = {
  id: "event-place-register", title: "Книга переездов", type: "архив",
  author: "", institution: "", archive: "ГАСО", fond: "6", opis: "13",
  delo: "104", sheet: "7", reference: "л. 7", url: "", accessedAt: "",
  description: "", documentIds: [],
};
const family = (): Family => ({ title: "Семья", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", birthPlace: "Тула", parents: [], spouses: [],
    generation: 1, column: 0, sources: [], createdBy: "owner",
    events: [{ id: "move", type: "move", date: "1901", place: "Москва",
      sources: [{ title: "Записка о переезде", type: "письмо", reference: "л. 2" }] }] }],
});
const cite = (value: Family) => {
  value.people[0].events![0].placeClaim = {
    value: "Москва", sources: [sourceCitation(source)],
  };
};
const actor = (id: string, role: ArchiveUser["role"]): ArchiveUser => ({
  id, role, name: id, createdAt: "2026-01-01",
});

test("event place citation keeps its own catalog slot and rejects a changed value or foreign source", async () => {
  const archive = await openArchive(":memory:", family());
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const before = (await archive.read()).family;
    const next = structuredClone(before);
    cite(next);
    assert.throws(() => authorizeArchive(next, before, actor("owner", "relative")),
      /только администратор/);
    assert.throws(() => authorizeArchive(next, before, actor("other", "researcher")),
      /только свои карточки/);
    await archive.write(authorizeArchive(next, before, actor("owner", "admin")),
      (await archive.read()).revision);
    const stored = (await archive.read()).family;
    assert.equal(stored.people[0].events![0].placeClaim?.sources[0].catalogId, source.id);
    assert.equal(allCitations(stored).length, 2, "general event evidence stays separate");
    const changed = structuredClone(stored);
    changed.people[0].events![0].place = "Казань";
    assert.throws(() => validateFamily(changed), /Источник места события относится к другому значению/);
    await assert.rejects(archive.write(changed, (await archive.read()).revision), /Источник места события/);
    const missing = structuredClone(stored);
    missing.people[0].events![0].place = undefined;
    assert.throws(() => validateFamily(missing), /Источник места события/);
    const foreign = structuredClone(stored);
    foreign.people[0].events![0].placeClaim!.sources[0].catalogId = "other-archive";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision), /Источник отсутствует/);
    const cleared = structuredClone(stored);
    cleared.people[0].events![0].place = "Казань";
    cleared.people[0].events![0].placeClaim = undefined;
    assert.doesNotThrow(() => validateFamily(cleared));
    await archive.write(cleared, (await archive.read()).revision);
    assert.equal((await archive.read()).family.people[0].events![0].placeClaim, undefined);

    const linked = structuredClone(stored);
    await archive.write(linked, (await archive.read()).revision);
    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Исправленная книга" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.people[0].events![0].placeClaim?.sources[0].title,
      "Исправленная книга");
  } finally { await archive.close(); }
});

test("HTTP refuses stale event place citation; .drevo and GEDCOM 5.5.1/7 keep it distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-place-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    await sourceCatalogStore(app.archive.db).insert(source);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    cite(next);
    const post = (current: Family, changed: Family, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes: archiveChanges(current, changed) }) });
    assert.equal((await post(before.family, next, before.revision)).status, 200);
    const saved = await app.archive.read();
    const changed = structuredClone(saved.family);
    changed.people[0].events![0].place = "Казань";
    assert.equal((await post(saved.family, changed, saved.revision)).status, 400);
    assert.equal((await app.archive.read()).family.people[0].events![0].place, "Москва");
    const deleteLinked = await fetch(`${origin}/api/sources/${source.id}`, {
      method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(deleteLinked.status, 409);

    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(stage);
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: saved.family, documents: [], comments: [], sources: [source],
    }, async () => {});
    const portable = await readPortablePackage(path, stage);
    assert.equal(portable.snapshot.family.people[0].events![0].placeClaim?.sources[0].catalogId,
      source.id);
    for (const version of ["5.5.1", "7.0"] as const) {
      const twoEvents = structuredClone(saved.family);
      twoEvents.people[0].events!.push({ id: "move-two", type: "move", date: "1902",
        place: "Казань", placeClaim: { value: "Казань", sources: [{
          title: "Книга переездов", type: "архив", reference: "л. 9",
        }] }, sources: [{ title: "Заметка", type: "письмо", reference: "л. 3" }] });
      const text = exportGedcom(twoEvents, { version });
      assert.match(text, /3 _DREVO_CLAIM EVENT_PLACE/);
      const importedEvents = importGedcom(text, `other-${version}`).family.people[0].events!;
      const imported = importedEvents.find((event) => event.id === "move")!;
      assert.equal(imported.placeClaim?.value, "Москва");
      assert.equal(imported.placeClaim?.sources[0].reference, "л. 7");
      assert.equal(imported.placeClaim?.sources[0].catalogId, undefined);
      assert.equal(imported.sources?.[0].title, "Записка о переезде");
      const second = importedEvents.find((event) => event.id === "move-two")!;
      assert.equal(second.placeClaim?.value, "Казань");
      assert.equal(second.placeClaim?.sources[0].reference, "л. 9");
      assert.equal(second.sources?.[0].reference, "л. 3");
      const external = text.replace(/^1 _DREVO .+\r\n/m, "");
      const parsedEvents = importGedcom(external, `external-${version}`).family.people[0].events!;
      const parsed = parsedEvents.find((event) => event.place === "Москва")!;
      assert.equal(parsed.placeClaim?.value, "Москва");
      assert.equal(parsed.sources?.length, 1);
      assert.equal(parsedEvents.find((event) => event.place === "Казань")?.placeClaim?.sources[0].reference,
        "л. 9");
    }
    const legacy = importGedcom(exportGedcom(family(), { version: "7.0" }), "legacy")
      .family.people[0].events!.find((event) => event.type === "move")!;
    assert.equal(legacy.placeClaim, undefined);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("GEDZIP remaps an event-place cited PDF and public share hides its local document ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-place-gedzip-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads); await mkdir(stage);
    const documentId = "11111111-1111-4111-8111-111111111111";
    const bytes = Buffer.from("%PDF-1.4\nevent place\n%%EOF");
    await writeFile(join(uploads, "record.pdf"), bytes);
    const data = family();
    data.people[0].events![0].placeClaim = { value: "Москва", sources: [{
      title: "Книга переездов", type: "архив", reference: "л. 7",
      documentId, documentPage: 4,
    }] };
    const path = join(directory, "family.gdz");
    await writeGenealogyPackage(path, uploads, data, [{ id: documentId,
      file: "documents/record.pdf", title: "Книга переездов", mime: "application/pdf",
      personIds: [], portraitIds: [], document: { documentType: "", documentDate: "",
        place: "", description: "", provenance: "" },
    }]);
    const imported = await prepareGenealogyImport(path, stage, "other");
    const claim = imported.family.people[0].events!.find((event) => event.type === "move")!
      .placeClaim!;
    assert.equal(claim.sources[0].documentPage, 4);
    assert.equal(claim.sources[0].documentId, imported.files[0].documentId);
    assert.notEqual(claim.sources[0].documentId, documentId);
    assert.deepEqual(await readFile(join(stage, imported.files[0].name)), bytes);
    const share = sharedFamily(data, { id: "share", title: "Фрагмент", anchorId: "anna",
      personIds: ["anna"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
      createdBy: "owner", createdName: "owner", revokedAt: null, lastVisitedAt: null }, "token");
    assert.equal(share.people[0].events![0].placeClaim?.sources[0].documentId, undefined);
    assert.equal(share.people[0].events![0].placeClaim?.sources[0].documentPage, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
