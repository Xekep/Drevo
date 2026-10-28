import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPromise } from "yauzl";
import { prepareArchiveExport, PREPARE_ARCHIVE_EXPORT_TOOL } from "../src/domain/research-export.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { openArchive } from "../src/server/database.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";

const person = (id: string): Person => ({ id, name: "Тест", surname: "Архивный", patronymic: "", sex: "u", birth: "1900", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: 0 });
const family: Family = { title: "Вымышленный архив", description: "", demo: false, people: [person("person/1")], photos: [], links: [] };
const owner: ArchiveUser = { id: "owner", name: "Владелец", approved: true, role: "relative", archiveOwner: true, createdAt: "" };
const reader: ArchiveUser = { id: "reader", name: "Участник", approved: true, role: "reader", archiveOwner: false, treeAccess: "common_ancestors", createdAt: "" };
const context = { family, actor: owner, pdfEnabled: true, selectedPersonId: "person/1" };

test("structured exports offer only available formats and preserve exact file types", () => {
  const before = structuredClone(context);
  assert.equal(PREPARE_ARCHIVE_EXPORT_TOOL.name, "prepare_archive_export");
  assert.deepEqual(prepareArchiveExport({ format: "options" }, context).files.map(file => file.url), [
    "drevo:tree-pdf:current", "drevo:tree-pdf:all",
    "/api/ai/export/gedcom?format=gedcom7", "/api/ai/export/gedcom?format=gedcom551",
    "/api/gedcom/export?format=gedzip7", "/api/ai/export/lineage?personId=person%2F1&direction=ancestors",
  ]);
  assert.deepEqual(prepareArchiveExport({ format: "tree_pdf", scope: "all" }, context).files,
    [{ name: "PDF всего древа", url: "drevo:tree-pdf:all" }]);
  assert.deepEqual(prepareArchiveExport({ format: "gedcom551" }, context).files,
    [{ name: "GEDCOM 5.5.1", url: "/api/ai/export/gedcom?format=gedcom551" }]);
  assert.deepEqual(prepareArchiveExport({ format: "gedzip7" }, context).files,
    [{ name: "GEDZIP 7", url: "/api/gedcom/export?format=gedzip7" }]);
  assert.deepEqual(prepareArchiveExport({ format: "lineage", direction: "descendants", personId: "person/1" }, context).files,
    [{ name: "Роспись потомков", url: "/api/ai/export/lineage?personId=person%2F1&direction=descendants" }]);
  assert.deepEqual(context, before);
});

test("GEDZIP requires the real owner grant and never silently becomes GEDCOM", () => {
  for (const actor of [reader, { ...owner, archiveOwner: false, role: "admin" as const }, { ...owner, approved: false }]) {
    const result = prepareArchiveExport({ format: "gedzip7" }, { ...context, actor });
    assert.deepEqual(result.files, []);
    assert.match(result.answer, /доступен владельцу/);
    assert.ok(!prepareArchiveExport({ format: "options" }, { ...context, actor }).files.some(file => file.name === "GEDZIP 7"));
  }
  const options = prepareArchiveExport({ format: "options" }, { ...context, actor: reader, pdfEnabled: false, selectedPersonId: undefined });
  assert.deepEqual(options.files.map(file => file.name), ["GEDCOM 7", "GEDCOM 5.5.1"]);
  assert.deepEqual(prepareArchiveExport({ format: "tree_pdf" }, { ...context, pdfEnabled: false }).files, []);
});

test("export arguments are structural, bounded and reject unknown or inaccessible people", () => {
  for (const value of ["Не экспортируй древо в PDF", "Сделай GEDZIP", null, [], {}, { format: "xml" },
    { format: "gedzip7", scope: "all" }, { format: "lineage", direction: "both" },
    { format: "tree_pdf", personId: "person/1" }, { format: "lineage", personId: "private" },
    { format: "lineage", personId: "x".repeat(201) }, { format: "lineage", personId: "person\n1" },
    { format: "gedcom7", url: "/api/export.json" }])
    assert.throws(() => prepareArchiveExport(value, context));
  assert.deepEqual(prepareArchiveExport({ format: "lineage" }, { ...context, selectedPersonId: "private" }).files, []);
  assert.deepEqual(prepareArchiveExport({ format: "lineage" }, { ...context, selectedPersonId: undefined }).files, []);
});

test("the prepared GEDZIP link downloads a real media ZIP and rechecks ownership before streaming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-ai-gedzip-"));
  const dbPath = join(directory, "test.sqlite"), name = `${randomUUID()}.png`;
  const documentId = randomUUID(), documentName = `${randomUUID()}.pdf`;
  const documentBytes = Buffer.from("%PDF-1.4\nSynthetic original document\n%%EOF\n");
  const media = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
  const seed: Family = { ...family, people: [{ ...family.people[0], photo: `/media/${name}` }] };
  const archive = await openArchive(dbPath, seed);
  let users: Array<ArchiveUser | null> = [];
  const auth = { currentUser: async () => users.length ? users.shift() : owner } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = gedcomHttp(archive, auth, dbPath);
  await writeFile(join(directory, "uploads", name), media);
  await writeFile(join(directory, "uploads", documentName), documentBytes);
  await archive.db.prepare("INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(documentId, "Вымышленный документ", "вымышленный документ", documentName, documentBytes.length, owner.id, new Date().toISOString());
  await archive.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run(documentId, seed.people[0].id);
  const server = createServer((req, res) => {
    void route.handle(req, res, new URL(req.url || "/", "http://localhost"))
      .then(handled => { if (!handled) res.writeHead(404).end(); })
      .catch(error => { if (!res.headersSent) res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const link = prepareArchiveExport({ format: "gedzip7" }, { ...context, family: seed }).files[0].url;
  const before = await archive.read();
  try {
    const response = await fetch(base + link);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/zip/);
    assert.match(response.headers.get("content-disposition") || "", /drevo\.gdz/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, "GEDZIP must contain ZIP bytes, not plain GEDCOM text");
    const path = join(directory, "export.gdz");
    await writeFile(path, bytes);
    const zip = await openPromise(path), entries = new Map<string, Buffer>();
    try {
      for await (const entry of zip.eachEntry()) {
        const chunks: Buffer[] = [];
        for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk));
        entries.set(entry.fileName, Buffer.concat(chunks));
      }
    } finally { zip.close(); }
    assert.deepEqual([...entries.keys()].sort(), ["gedcom.ged", `media/${name}`, `media/${documentName}`].sort());
    assert.deepEqual(entries.get(`media/${name}`), media);
    assert.deepEqual(entries.get(`media/${documentName}`), documentBytes);
    assert.match(entries.get("gedcom.ged")!.toString("utf8"), /2 VERS 7\.0/);
    for (const denied of [reader, { ...owner, archiveOwner: false, role: "admin" as const }, null]) {
      users = [denied];
      const inaccessible = await fetch(base + link);
      assert.equal(inaccessible.status, denied ? 403 : 401);
      assert.doesNotMatch(await inaccessible.text(), /GEDC|media\//);
    }
    users = [owner, reader];
    const revoked = await fetch(base + link);
    assert.equal(revoked.status, 403);
    assert.doesNotMatch(await revoked.text(), /GEDC|media\//);
    assert.deepEqual(await archive.read(), before);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await route.close();
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
