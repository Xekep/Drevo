import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family, Person } from "../src/domain/types.ts";
import { archiveConnections } from "../src/domain/connections.ts";
import { openArchive } from "../src/server/database.ts";
import { fullBackup } from "../src/server/full-backup.ts";
import { restoreStore } from "../src/server/restore.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";

const documentId = "426494de-030c-4eb2-86fc-44594b7990a1";
const originalName = `${documentId}.pdf`;
const person = (id: string): Person => ({
  id, name: id, surname: "Example", patronymic: "", sex: "u",
  birth: "", birthPlace: "", parents: [], spouses: [],
  generation: 1, column: 0, sources: [],
});
const emptyFamily = (): Family => ({ title: "Parent evidence", description: "",
  demo: false, people: [] });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("full TAR restore remaps two parent citations and catalog PDF without changing their edges or pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-parent-restore-"));
  const sourceRoot = join(root, "source"), targetRoot = join(root, "target");
  await Promise.all([
    mkdir(join(sourceRoot, "uploads"), { recursive: true }),
    mkdir(join(targetRoot, "uploads"), { recursive: true }),
  ]);
  const sourcePath = join(sourceRoot, "archive.sqlite");
  const targetPath = join(targetRoot, "archive.sqlite");
  const source = await openArchive(sourcePath, emptyFamily());
  const target = await openArchive(targetPath, emptyFamily());
  const restores = restoreStore(target, targetPath);
  const original = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const server = createServer((_req, res) => {
    void fullBackup(source.db, sourcePath, res).catch((error) => {
      if (res.headersSent) res.destroy(error as Error);
      else { res.statusCode = 500; res.end(String(error)); }
    });
  });
  try {
    await writeFile(join(sourceRoot, "uploads", originalName), original);
    await source.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
       document_date,place,description,provenance,annotations,event_links,pages)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      documentId, "Parent register", "parent register", originalName,
      original.length, "source-editor", "2026-01-01T00:00:00Z", "registry", "",
      "", "", "Synthetic archive", "[]", "[]", "[]",
    );
    await sourceCatalogStore(source.db).insert({
      id: "parent-register", title: "Parent register", type: "archive", author: "",
      institution: "", archive: "Synthetic archive", fond: "", opis: "", delo: "",
      sheet: "", reference: "leaf 12", url: "", accessedAt: "", description: "",
      documentIds: [documentId],
    });
    const family: Family = { ...emptyFamily(), people: [
      person("father"), person("mother"), {
        ...person("child"), parents: ["father", "mother"], parentClaims: [
          { parentId: "father", confidence: "confirmed", sources: [{
            catalogId: "parent-register", title: "Parent register", type: "archive",
            reference: "leaf 12", documentId, documentPage: 2,
          }] },
          { parentId: "mother", confidence: "probable", sources: [{
            title: "Independent register", type: "book", reference: "leaf 27",
            documentId, documentPage: 7,
          }] },
        ],
      },
    ] };
    await source.write(family, (await source.read()).revision);
    await source.db.prepare(
      "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
    ).run(documentId, "child");

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200, await response.clone().text());
    const backup = Buffer.from(await response.arrayBuffer());
    const admin = { id: "admin", name: "Admin", role: "admin" as const,
      createdAt: "2026-01-01T00:00:00Z" };
    const preview = await restores.preview(backup, admin);
    assert.equal(preview.missing, 0);
    assert.equal(preview.people, 3);
    const stage = await target.db.prepare(
      "SELECT data FROM workflow_stages WHERE token=?",
    ).get(preview.token);
    const stagedDocuments = (JSON.parse(String(stage?.data)) as {
      documentFiles: Array<[string, string]>;
    }).documentFiles;
    assert.equal(stagedDocuments.length, 1);
    assert.equal((await stat(stagedDocuments[0][1])).size, original.length);
    await restores.apply(preview.token, admin, async () => {});

    const restored = (await target.read()).family;
    const child = restored.people.find((item) => item.id === "child")!;
    assert.deepEqual(child.parents, ["father", "mother"]);
    assert.equal(archiveConnections(restored).filter((edge) => edge.type === "parent").length, 2);
    const byParent = new Map(child.parentClaims?.map((claim) => [claim.parentId, claim]));
    assert.deepEqual([...byParent.keys()].sort(), ["father", "mother"]);
    assert.equal(byParent.get("father")?.confidence, "confirmed");
    assert.equal(byParent.get("mother")?.confidence, "probable");
    const first = byParent.get("father")?.sources?.[0];
    const second = byParent.get("mother")?.sources?.[0];
    const document = await target.db.prepare(
      "SELECT id,file_name FROM documents WHERE title=?",
    ).get("Parent register");
    assert.ok(document);
    assert.notEqual(document.id, documentId, "full restore remaps the source document ID");
    assert.notEqual(document.file_name, originalName);
    assert.equal(first?.catalogId, "parent-register");
    assert.equal(first?.reference, "leaf 12");
    assert.equal(first?.documentId, document.id);
    assert.equal(first?.documentPage, 2);
    assert.equal(second?.title, "Independent register");
    assert.equal(second?.reference, "leaf 27");
    assert.equal(second?.documentId, document.id);
    assert.equal(second?.documentPage, 7);
    assert.equal(hash(await readFile(join(targetRoot, "uploads", String(document.file_name)))),
      hash(original));
    const catalog = await sourceCatalogStore(target.db).get("parent-register");
    assert.deepEqual(catalog?.documentIds, [document.id]);
    const links = await target.db.prepare(
      "SELECT person_id FROM document_people WHERE document_id=?",
    ).all(String(document.id));
    assert.deepEqual(links.map((row) => row.person_id), ["child"]);
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
