import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Family } from "../src/domain/types.ts";
import type { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { portableExportHttp } from "../src/server/portable-http.ts";
import { portableImportHttp } from "../src/server/portable-import-http.ts";
import { discussionAttachmentStore, prepareCommentFile } from "../src/server/discussion-attachments.ts";
import { userStore } from "../src/server/users.ts";

test("representative family fixture survives Drevo to .drevo to Drevo with evidence and originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-roundtrip-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  await mkdir(join(sourceRoot, "uploads"), { recursive: true });
  await mkdir(targetRoot);
  const original = await sharp({ create: {
    width: 4, height: 4, channels: 4, background: "#c39b76",
  } }).png().toBuffer();
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
  await writeFile(join(sourceRoot, "uploads", "portrait.png"), original);
  await writeFile(join(sourceRoot, "uploads", "gallery.png"), original);
  await writeFile(join(sourceRoot, "uploads", "evidence.png"), original);
  await writeFile(join(sourceRoot, "uploads", "record.pdf"), pdf);
  const family = JSON.parse(await readFile(join("tests", "fixtures", "family.json"), "utf8")) as Family;
  const documentId = "36db38fd-f709-44dc-b481-52ef56bf0656";
  const eventId = "residence-record";
  family.people[0].events = [{
    id: eventId, type: "residence", date: "1900", place: "Tver",
    sources: [{ title: "Census", type: "archive", reference: "folio 7",
      url: "https://example.test/census" }],
  }];
  family.unions = [{
    id: "union-1", participants: [family.people[0].id, family.people[1].id],
    type: "marriage", formation: { date: "1865", place: "Tver",
      sources: [{ title: "Marriage register", type: "archive", reference: "folio 2" }] },
    note: "Original register checked",
  }];
  family.links = [{
    id: "link-1", from: family.people[0].id, to: family.people[2].id,
    type: "guardian", note: "Named guardian in register",
    sources: [{ title: "Guardian register", type: "archive", reference: "folio 8" }],
  }];
  family.people[0].photo = "/media/portrait.png";
  family.people[0].sources.push({
    title: "Семейная фотография", type: "фотография", reference: "оборот",
    url: "/media/evidence.png?download=1#scan",
  });
  family.photos = [{ id: "gallery-1", url: "/media/gallery.png", title: "Семья",
    takenAt: "1900", place: "Тверь", description: "Подпись на обороте",
    tags: [{ id: "tag-1", personId: family.people[0].id,
      x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] }];
  const source = await openArchive(join(sourceRoot, "archive.sqlite"), family);
  const targetPath = join(targetRoot, "archive.sqlite");
  const target = await openArchive(targetPath, {
    title: "Пустое дерево", description: "", demo: false, people: [], photos: [],
  });
  const owner = await (await userStore(target.db, { requireInitialAdmin: false }))
    .register("new-owner", "Новый владелец");
  await source.db.prepare(`INSERT INTO documents
    (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
     document_date,place,description,provenance,annotations,event_links,pages)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    documentId, "Запись о семье", "запись о семье", "record.pdf", pdf.length,
    "old-owner", "2026-09-30T00:00:00Z", "Метрическая книга", "1900", "Тверь",
    "Семья Соколовых", "Государственный архив", JSON.stringify([{
      id: "eb4edbfa-940f-48f4-a329-cbdff3df7b8d", authorId: "old-owner",
      authorName: "Историк", createdAt: "2026-09-30T00:00:00Z", page: 1,
      x: 0.1, y: 0.2, width: 0.3, height: 0.2, text: "Строка о рождении",
    }]), JSON.stringify([{ personId: family.people[0].id, eventId, page: 1 }]),
    JSON.stringify([{ number: 1, description: "Лист 7: о семье" }]),
  );
  await source.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run(documentId, family.people[0].id);
  await source.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run(documentId, family.people[1].id);
  await source.db.prepare("INSERT INTO source_catalog(id,data,version) VALUES(?,?,1)")
    .run("catalog-record", JSON.stringify({ id: "catalog-record", title: "Метрическая книга",
      type: "архив", author: "", institution: "", archive: "Государственный архив",
      fond: "2", opis: "1", delo: "4", sheet: "7", reference: "л. 7", url: "",
      accessedAt: "", description: "", documentIds: [documentId] }));
  family.people[0].sources.push({
    title: "Метрическая книга", type: "архив", reference: "л. 7",
    catalogId: "catalog-record", documentId, documentPage: 1,
  });
  await source.write(family, (await source.read()).revision);
  const note = Buffer.from("Номер фонда и дела: 2/1/4", "utf8");
  const attachments = await discussionAttachmentStore(join(sourceRoot, "uploads"))
    .save([await prepareCommentFile("archive-note.txt", note)]);
  await source.db.prepare(`INSERT INTO person_comments
    (person_id,author_id,author_name,created_ms,text,updated_ms,attachments)
    VALUES(?,?,?,?,?,?,?)`).run(family.people[0].id, "old-owner", "Историк", 1000,
    "Проверено по книге", 2000, JSON.stringify(attachments));
  const sourceAuth = { local: true, currentUser: () => ({
    id: "old-owner", name: "Историк", role: "admin", approved: true, createdAt: "",
  }) } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const targetAuth = { local: true, currentUser: () => owner } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const exporter = portableExportHttp(source, sourceAuth, join(sourceRoot, "uploads"));
  const importer = portableImportHttp(target, targetAuth, targetPath);
  const sourceServer = createServer((req, res) => { void exporter(req, res, new URL(req.url!, "http://localhost")); });
  const targetServer = createServer((req, res) => { void importer.handle(req, res, new URL(req.url!, `http://${req.headers.host}`)); });
  await Promise.all([
    new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    const sourceUrl = `http://127.0.0.1:${(sourceServer.address() as { port: number }).port}`;
    const targetUrl = `http://127.0.0.1:${(targetServer.address() as { port: number }).port}`;
    const response = await fetch(`${sourceUrl}/api/drevo/export`);
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    const bytes = Buffer.from(await response.arrayBuffer());
    const preview = await fetch(`${targetUrl}/api/drevo/preview`, {
      method: "POST", headers: { Origin: targetUrl, "X-Drevo-Import": "1" }, body: bytes,
    });
    assert.equal(preview.status, 200, preview.status === 200 ? "" : await preview.text());
    const { token } = await preview.json() as { token: string };
    const applied = await fetch(`${targetUrl}/api/drevo/import`, {
      method: "POST", headers: { Origin: targetUrl, "X-Drevo-Import": "1",
        "Content-Type": "application/json" },
      body: JSON.stringify({ token, confirm: true }),
    });
    assert.equal(applied.status, 200, await applied.text());
    const sourceFamily = (await source.read()).family;
    const targetFamily = (await target.read()).family;
    assert.equal(targetFamily.people.length, 22);
    assert.equal(targetFamily.photos?.length, 1);
    const evidenceUrl = targetFamily.people[0].sources.find((item) => item.title === "Семейная фотография")?.url;
    assert.ok(evidenceUrl);
    assert.ok(evidenceUrl.startsWith("/media/") && evidenceUrl.endsWith("?download=1#scan"));
    const evidenceName = new URL(evidenceUrl, "http://localhost").pathname.slice(7);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", evidenceName)), original,
      "a local citation image must remain available after import");
    const normalized = structuredClone(targetFamily);
    normalized.people[0].photo = "/media/portrait.png";
    normalized.photos![0].url = "/media/gallery.png";
    normalized.people[0].sources.find((item) => item.title === "Семейная фотография")!.url = "/media/evidence.png?download=1#scan";
    assert.deepEqual(normalized, sourceFamily);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", targetFamily.people[0].photo!.slice(7))), original);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", targetFamily.photos![0].url.slice(7))), original);
    const doc = await target.db.prepare("SELECT title,file_name,document_type,document_date,place,description,provenance,annotations,pages FROM documents").get();
    assert.equal(doc?.title, "Запись о семье");
    assert.equal(doc?.document_type, "Метрическая книга");
    assert.equal(doc?.document_date, "1900");
    assert.equal(doc?.place, "Тверь");
    assert.equal(doc?.description, "Семья Соколовых");
    assert.equal(doc?.provenance, "Государственный архив");
    assert.deepEqual(await readFile(join(targetRoot, "uploads", String(doc?.file_name))), pdf);
    assert.equal((JSON.parse(String(doc?.annotations)) as Array<{ text: string }>)[0].text, "Строка о рождении");
    assert.equal((JSON.parse(String(doc?.pages)) as Array<{ description: string }>)[0].description, "Лист 7: о семье");
    const documentLinks = await target.db.prepare(
      "SELECT document_id,person_id FROM document_people ORDER BY person_id",
    ).all();
    assert.deepEqual(documentLinks.map((row) => ({
      document_id: row.document_id, person_id: row.person_id,
    })), [family.people[1].id, family.people[0].id].map((person_id) => ({
      document_id: documentId, person_id,
    })));
    const eventLinks = await target.db.prepare("SELECT event_links FROM documents WHERE id=?").get(documentId);
    assert.deepEqual(JSON.parse(String(eventLinks?.event_links)),
      [{ personId: family.people[0].id, eventId, page: 1 }]);
    const comment = await target.db.prepare("SELECT text,updated_ms,attachments FROM person_comments").get();
    assert.equal(comment?.text, "Проверено по книге");
    assert.equal(comment?.updated_ms, 2000);
    const restoredFiles = JSON.parse(String(comment?.attachments)) as Array<{ id: string; name: string }>;
    assert.equal(restoredFiles[0]?.name, "archive-note.txt");
    assert.deepEqual(await readFile(join(targetRoot, "uploads", "discussion-files", restoredFiles[0].id)), note);
    const sourceCatalog = await source.db.prepare("SELECT data FROM source_catalog WHERE id='catalog-record'").get();
    const targetCatalog = await target.db.prepare("SELECT data FROM source_catalog WHERE id='catalog-record'").get();
    assert.deepEqual(JSON.parse(String(targetCatalog?.data)), JSON.parse(String(sourceCatalog?.data)));
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => sourceServer.close(() => resolve())),
      new Promise<void>((resolve) => targetServer.close(() => resolve())),
    ]);
    await importer.close();
    await source.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});
