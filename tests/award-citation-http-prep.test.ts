import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server/index.ts";
import { archiveChanges } from "../src/domain/changes.ts";
import { sourceCitation } from "../src/shared/source-catalog.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";

test("award citations use the full HTTP writer and reject foreign catalog IDs atomically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-award-prep-http-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  const app = await startServer(0, join(directory, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const empty = await app.archive.read();
    await app.archive.write({ title: "Награды", description: "", demo: false,
      people: [{ id: "hero", name: "Иван", surname: "Примеров", patronymic: "",
        sex: "m", birth: "", birthPlace: "", parents: [], spouses: [],
        generation: 1, column: 0, sources: [] }] }, empty.revision);
    const first = await app.archive.read();
    const person = first.family.people[0];
    assert.ok(person);
    const stored = await app.archive.read();
    const documentId = "d0c00000-0000-4000-8000-000000000001";
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
    mkdirSync(join(directory, "uploads"), { recursive: true });
    writeFileSync(join(directory, "uploads", `${documentId}.pdf`), pdf);
    await app.archive.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
       document_date,place,description,provenance,annotations,event_links,pages)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(documentId, "Наградной лист", "наградной лист",
      `${documentId}.pdf`, pdf.length, "owner", "2026-01-01T00:00:00Z",
      "", "", "", "", "", "[]", "[]", "[]");
    const catalog = { id: "award-record", title: "Наградная книга", type: "архив",
      author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
      sheet: "", reference: "л. 2", url: "", accessedAt: "", description: "",
      documentIds: [documentId] };
    await sourceCatalogStore(app.archive.db).insert(catalog);
    const request = (method: "PUT" | "POST", revision: number, body: unknown) =>
      fetch(base + (method === "PUT" ? "/api/family" : "/api/family/changes"), {
        method,
        headers: { Origin: base, "Content-Type": "application/json",
          "If-Match": String(revision) },
        body: JSON.stringify(body),
      });
    const added = structuredClone(stored.family);
    added.people[0].awards = [{ id: "award-prep", name: "Медаль", sources: [{
      title: "Наградной лист", type: "архив", reference: "л. 2",
    }] }];
    const created = await request("POST", stored.revision,
      { changes: archiveChanges(stored.family, added) });
    assert.equal(created.status, 200, await created.text());
    const saved = await app.archive.read();
    assert.equal(saved.family.people[0].awards?.[0].sources?.[0].reference, "л. 2");
    const oldClient = structuredClone(saved.family);
    delete oldClient.people[0].awards![0].sources;
    oldClient.people[0].surname = "Уточнён";
    const unchanged = await request("PUT", saved.revision, oldClient);
    assert.equal(unchanged.status, 200, await unchanged.text());
    const preserved = await app.archive.read();
    assert.equal(preserved.family.people[0].awards?.[0].sources?.[0].reference, "л. 2");
    const copied = structuredClone(preserved.family);
    copied.people[0].awards!.push({ id: "award-catalog", name: "Другая медаль",
      sources: [{ ...sourceCitation(catalog), documentPage: 3 }] });
    const linked = await request("POST", preserved.revision,
      { changes: archiveChanges(preserved.family, copied) });
    assert.equal(linked.status, 200, await linked.text());
    const withCatalog = await app.archive.read();
    assert.equal(withCatalog.family.people[0].awards?.[1].sources?.[0].documentId, documentId);
    assert.equal(withCatalog.family.people[0].awards?.[1].sources?.[0].documentPage, 3);
    const wrongDocument = structuredClone(withCatalog.family);
    wrongDocument.people[0].awards![1].sources![0].documentId =
      "f0c00000-0000-4000-8000-000000000002";
    const deniedDocument = await request("POST", withCatalog.revision,
      { changes: archiveChanges(withCatalog.family, wrongDocument) });
    assert.equal(deniedDocument.status, 400);
    assert.match(await deniedDocument.text(), /Документ цитаты отсутствует у источника/);
    assert.equal((await app.archive.read()).revision, withCatalog.revision);
    const edited = structuredClone(withCatalog.family);
    edited.people[0].awards![0].sources![0].catalogId = "foreign-catalog";
    const denied = await request("POST", withCatalog.revision,
      { changes: archiveChanges(withCatalog.family, edited) });
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /Источник отсутствует в этом архиве/);
    const remove = structuredClone(withCatalog.family);
    remove.people[0].awards = [];
    const acceptedRemoval = await request("POST", withCatalog.revision,
      { changes: archiveChanges(withCatalog.family, remove) });
    assert.equal(acceptedRemoval.status, 200, await acceptedRemoval.text());
    assert.equal((await app.archive.read()).revision, withCatalog.revision + 1);
    assert.deepEqual((await app.archive.read()).family.people[0].awards, []);
  } finally {
    await app.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(directory, { recursive: true, force: true });
  }
});
