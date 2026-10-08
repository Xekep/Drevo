import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family } from "../src/domain/types.ts";
import { openArchive } from "../src/server/database.ts";
import { fullBackup } from "../src/server/full-backup.ts";
import { portableImportHttp } from "../src/server/portable-import-http.ts";
import { writePortablePackage, type PortableSnapshot } from "../src/server/portable-package.ts";
import { restoreStore } from "../src/server/restore.ts";
import { userStore } from "../src/server/users.ts";
import type { createAuth } from "../src/server/auth.ts";

const documentId = "23f3bb4f-25d5-429c-8b42-1a67dc4a981b";
const originalName = `${documentId}.pdf`;
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const empty = (): Family => ({ title: "Пустое древо", description: "", demo: false,
  people: [], photos: [] });
const withCitation = (): Family => ({ ...empty(), people: [{
  id: "person", name: "Иван", surname: "Примеров", patronymic: "", sex: "m",
  birth: "", birthPlace: "", parents: [], spouses: [], generation: 1,
  column: 0, sources: [], awards: [{ id: "award", name: "Медаль", sources: [{
    title: "Наградной лист", type: "архив", reference: "л. 2",
    documentId, documentPage: 2,
  }] }],
}] });
const catalog = { id: "award-register", title: "Наградная книга", type: "архив",
  author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
  sheet: "", reference: "л. 2", url: "", accessedAt: "", description: "",
  documentIds: [documentId] };
const document = { id: documentId, title: "Наградной лист", fileName: originalName,
  uploadedBy: "owner", createdAt: "2026-01-01T00:00:00Z", documentType: "",
  documentDate: "", place: "", description: "", provenance: "",
  annotations: [], personIds: ["person"] };

test("portable apply retains an award PDF citation and original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "award-prep-portable-"));
  const source = join(root, "source"), target = join(root, "target");
  await Promise.all([mkdir(source), mkdir(target)]);
  const packagePath = join(root, "archive.drevo");
  const archivePath = join(target, "archive.sqlite");
  let archive: Awaited<ReturnType<typeof openArchive>> | undefined;
  let route: ReturnType<typeof portableImportHttp> | undefined;
  const server = createServer((req, res) => {
    void route!.handle(req, res, new URL(req.url!, `http://${req.headers.host}`));
  });
  try {
    await writeFile(join(source, originalName), pdf);
    const packaged = withCitation();
    packaged.people[0].awards![0].sources![0].catalogId = catalog.id;
    packaged.people[0].awards![0].sources![0].title = catalog.title;
    const snapshot: PortableSnapshot = { family: packaged, documents: [document],
      comments: [], sources: [catalog] };
    await writePortablePackage(createWriteStream(packagePath), source, snapshot,
      async () => {});
    archive = await openArchive(archivePath, empty());
    const owner = await (await userStore(archive.db, { requireInitialAdmin: false }))
      .register("owner", "Owner");
    const auth = { local: true, currentUser: async () => owner } as unknown as
      Awaited<ReturnType<typeof createAuth>>;
    route = portableImportHttp(archive, auth, archivePath);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Origin: base, "X-Drevo-Import": "1" };
    const previewResponse = await fetch(`${base}/api/drevo/preview`, {
      method: "POST", headers, body: await readFile(packagePath),
    });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json() as { token: string };
    const apply = await fetch(`${base}/api/drevo/import`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ token: preview.token, confirm: true }),
    });
    assert.equal(apply.status, 200, await apply.text());
    const result = await archive.read();
    assert.equal(result.family.people[0].awards?.[0].sources?.[0].documentId, documentId);
    assert.equal(result.family.people[0].awards?.[0].sources?.[0].documentPage, 2);
    assert.equal(result.family.people[0].awards?.[0].sources?.[0].catalogId, catalog.id);
    assert.equal((await archive.db.prepare("SELECT count(*) AS n FROM source_catalog WHERE id=?")
      .get(catalog.id))?.n, 1);
    const storedDocument = await archive.db.prepare("SELECT file_name FROM documents WHERE id=?")
      .get(documentId);
    assert.ok(storedDocument?.file_name);
    assert.notEqual(storedDocument.file_name, originalName, "portable originals get fresh names");
    assert.deepEqual(await readFile(join(target, "uploads", String(storedDocument.file_name))), pdf);
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await route?.close();
    await archive?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TAR restore remaps an award PDF citation and retains original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "award-prep-restore-"));
  const sourceRoot = join(root, "source"), targetRoot = join(root, "target");
  await Promise.all([
    mkdir(join(sourceRoot, "uploads"), { recursive: true }),
    mkdir(join(targetRoot, "uploads"), { recursive: true }),
  ]);
  const sourcePath = join(sourceRoot, "archive.sqlite");
  const targetPath = join(targetRoot, "archive.sqlite");
  const source = await openArchive(sourcePath, empty());
  const target = await openArchive(targetPath, empty());
  const restores = restoreStore(target, targetPath);
  const server = createServer((_req, res) => {
    void fullBackup(source.db, sourcePath, res).catch((error) => {
      if (res.headersSent) res.destroy(error as Error);
      else { res.statusCode = 500; res.end(String(error)); }
    });
  });
  try {
    await writeFile(join(sourceRoot, "uploads", originalName), pdf);
    await source.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
       document_date,place,description,provenance,annotations,event_links,pages)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      documentId, document.title, "наградной лист", originalName, pdf.length,
      "owner", document.createdAt, "", "", "", "", "", "[]", "[]", "[]",
    );
    const seeded = withCitation().people[0];
    await source.db.prepare(`INSERT INTO people(id,data) VALUES(?,?)`)
      .run(seeded.id, JSON.stringify({ ...seeded, parents: undefined,
        spouses: undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    assert.equal(response.status, 200, await response.clone().text());
    const admin = { id: "admin", name: "Admin", role: "admin" as const,
      createdAt: "2026-01-01T00:00:00Z" };
    const preview = await restores.preview(Buffer.from(await response.arrayBuffer()), admin);
    await restores.apply(preview.token, admin, async () => {});
    const restored = await target.read();
    const remappedId = restored.family.people[0].awards?.[0].sources?.[0].documentId;
    assert.ok(remappedId);
    assert.notEqual(remappedId, documentId);
    assert.equal(restored.family.people[0].awards?.[0].sources?.[0].documentPage, 2);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", `${remappedId}.pdf`)), pdf);
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await restores.close();
    await target.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
