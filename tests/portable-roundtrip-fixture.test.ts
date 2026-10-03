import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Family } from "../src/domain/types.ts";
import { storedDocumentFileType } from "../src/shared/document-file.ts";
import type { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { portableExportHttp } from "../src/server/portable-http.ts";
import { portableImportHttp } from "../src/server/portable-import-http.ts";
import { writePortablePackage, type PortableSnapshot } from "../src/server/portable-package.ts";
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
  const legacyJpeg = await sharp({ create: {
    width: 4, height: 4, channels: 3, background: "#2d7a8f",
  } }).jpeg().toBuffer();
  const legacyTiff = await sharp({ create: {
    width: 4, height: 4, channels: 3, background: "#8f7a2d",
  } }).tiff().toBuffer();
  const legacyJpegName = "acdd620b-68f0-40e1-a126-775a293b9316.jpeg";
  const legacyTiffName = "bba1d591-f6d3-48e5-a3c5-a9553c349a22.tiff";
  const legacyJpegId = "de9cd757-0a0d-49c6-9644-f84574499c62";
  const legacyTiffId = "b7d4948e-370f-4dd9-a397-6eb471b2203c";
  assert.equal(storedDocumentFileType(legacyJpegName)?.mime, "image/jpeg");
  assert.equal(storedDocumentFileType(legacyTiffName)?.mime, "image/tiff");
  await writeFile(join(sourceRoot, "uploads", "portrait.png"), original);
  await writeFile(join(sourceRoot, "uploads", "gallery.png"), original);
  await writeFile(join(sourceRoot, "uploads", "evidence.png"), original);
  await writeFile(join(sourceRoot, "uploads", "record.pdf"), pdf);
  await writeFile(join(sourceRoot, "uploads", legacyJpegName), legacyJpeg);
  await writeFile(join(sourceRoot, "uploads", legacyTiffName), legacyTiff);
  const family = JSON.parse(await readFile(join("tests", "fixtures", "family.json"), "utf8")) as Family;
  const documentId = "36db38fd-f709-44dc-b481-52ef56bf0656";
  const eventId = "residence-record";
  const archiveEvidence = { title: "Census", type: "archive", reference: "folio 7" };
  family.people[0].createdBy = "old-owner";
  // Older imports can carry additional Person JSON that the current domain
  // still stores verbatim. The compatibility guard must not discard it.
  (family.people[0] as typeof family.people[number] & { legacyCustomNote: string })
    .legacyCustomNote = "Original transcription retained";
  family.people[0].needsReview = true;
  family.people[0].birthDateClaim = { value: family.people[0].birth,
    sources: [archiveEvidence], confidence: "confirmed" };
  family.people[0].deathDateClaim = { value: family.people[0].death!,
    sources: [archiveEvidence], confidence: "confirmed" };
  family.people[0].birthPlaceClaim = { value: family.people[0].birthPlace,
    sources: [archiveEvidence], confidence: "probable" };
  family.people[0].birthLocation = { place: family.people[0].birthPlace,
    lat: 56.86, lon: 35.91, label: "Тверь" };
  family.people[0].occupationClaim = { value: family.people[0].occupation!,
    sources: [archiveEvidence], confidence: "tentative" };
  family.people[0].factAlternatives = [{ id: "alternative-place", field: "birthPlace",
    value: "Кашин", sources: [{ ...archiveEvidence, reference: "folio 9" }],
    confidence: "conflicting" }];
  family.people[0].awards = [{ id: "award-1", name: "Почётная грамота", year: "1900",
    source: { title: "Наградной лист", url: "https://example.test/award" } }];
  family.people[1].maidenName = "Иванова";
  family.people[1].maidenNameClaim = { value: "Иванова", sources: [archiveEvidence],
    confidence: "probable" };
  family.people[0].events = [{
    id: eventId, type: "residence", date: "1900", place: "Tver",
    dateClaim: { value: "1900", sources: [archiveEvidence], confidence: "confirmed" },
    placeClaim: { value: "Tver", sources: [archiveEvidence], confidence: "probable" },
    alternatives: [{ id: "alternate-event-place", field: "place", value: "Torzhok",
      sources: [archiveEvidence], confidence: "conflicting" }],
    sources: [{ title: "Census", type: "archive", reference: "folio 7",
      url: "https://example.test/census" }],
  }];
  family.unions = [{
    id: "union-1", createdBy: "old-owner",
    participants: [family.people[0].id, family.people[1].id],
    type: "marriage", confidence: "confirmed", formation: { date: "1865", place: "Tver",
      confidence: "confirmed",
      sources: [{ title: "Marriage register", type: "archive", reference: "folio 2" }] },
    ongoing: { dateText: "около 1880 года", sources: [archiveEvidence] },
    note: "Original register checked",
  }];
  family.links = [{
    id: "link-1", createdBy: "old-owner",
    from: family.people[0].id, to: family.people[2].id,
    type: "guardian", note: "Named guardian in register", confidence: "probable",
    sources: [{ title: "Guardian register", type: "archive", reference: "folio 8" }],
  }];
  family.people[0].photo = "/media/portrait.png";
  family.people[0].sources.push({
    title: "Семейная фотография", type: "фотография", reference: "оборот",
    url: "/media/evidence.png?download=1#scan",
  });
  family.people[1].sources.push({
    title: "Legacy JPEG register scan", type: "archive", reference: "leaf 12",
    documentId: legacyJpegId,
  });
  family.photos = [{ id: "gallery-1", createdBy: "old-owner",
    url: "/media/gallery.png", title: "Семья",
    createdAt: "2026-09-30T00:00:00.000Z", takenAt: "1900", place: "Тверь",
    description: "Подпись на обороте",
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
  for (const [id, name, size, title] of [
    [legacyJpegId, legacyJpegName, legacyJpeg.length, "Legacy JPEG scan"],
    [legacyTiffId, legacyTiffName, legacyTiff.length, "Legacy TIFF scan"],
  ] as const)
    await source.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, title, title.toLowerCase(), name, size,
      "old-owner", "2026-09-30T00:00:00Z");
  await source.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run(documentId, family.people[0].id);
  await source.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run(documentId, family.people[1].id);
  await source.db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run(legacyJpegId, family.people[1].id);
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
  const attachmentOnlyBytes = Buffer.from("Отдельная расшифровка", "utf8");
  const attachmentOnly = await discussionAttachmentStore(join(sourceRoot, "uploads"))
    .save([await prepareCommentFile("transcription.txt", attachmentOnlyBytes)]);
  await source.db.prepare(`INSERT INTO person_comments
    (person_id,author_id,author_name,created_ms,text,updated_ms,attachments)
    VALUES(?,?,?,?,?,?,?)`).run(family.people[0].id, "old-owner", "Историк", 3000,
    "", null, JSON.stringify(attachmentOnly));
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
    const catalogBefore = String((await source.db.prepare(
      "SELECT data FROM source_catalog WHERE id='catalog-record'",
    ).get())?.data);
    await source.db.prepare("UPDATE source_catalog SET data=? WHERE id='catalog-record'")
      .run(JSON.stringify({ ...JSON.parse(catalogBefore), futureEvidence: "Retained by older data" }));
    const unsafeExport = await fetch(`${sourceUrl}/api/drevo/export`);
    assert.equal(unsafeExport.status, 409,
      "export must not silently strip previously stored source-catalog metadata");
    assert.match(await unsafeExport.text(), /неподдерживаемые поля источника/);
    await source.db.prepare("UPDATE source_catalog SET data=? WHERE id='catalog-record'")
      .run(catalogBefore);
    const response = await fetch(`${sourceUrl}/api/drevo/export`);
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    const bytes = Buffer.from(await response.arrayBuffer());
    const unknownPackage = join(root, "unsupported.drevo");
    await writePortablePackage(createWriteStream(unknownPackage), sourceRoot,
      { family: { title: "Unsupported", description: "", demo: false, people: [] },
        documents: [], comments: [], sources: [],
        futureEvidence: [{ title: "Must not disappear" }],
      } as PortableSnapshot, async () => {});
    const unsupported = await fetch(`${targetUrl}/api/drevo/preview`, {
      method: "POST", headers: { Origin: targetUrl, "X-Drevo-Import": "1" },
      body: await readFile(unknownPackage),
    });
    assert.equal(unsupported.status, 400);
    assert.match(await unsupported.text(), /неподдерживаемые поля/);
    const preview = await fetch(`${targetUrl}/api/drevo/preview`, {
      method: "POST", headers: { Origin: targetUrl, "X-Drevo-Import": "1" }, body: bytes,
    });
    assert.equal(preview.status, 200, preview.status === 200 ? "" : await preview.text());
    const previewData = await preview.json() as { token: string; comments: number };
    assert.equal(previewData.comments, 2);
    const { token } = previewData;
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
    const expected = structuredClone(sourceFamily);
    delete expected.people[0].createdBy;
    delete expected.unions![0].createdBy;
    delete expected.links![0].createdBy;
    delete expected.photos![0].createdBy;
    normalized.people[0].photo = "/media/portrait.png";
    normalized.photos![0].url = "/media/gallery.png";
    normalized.people[0].sources.find((item) => item.title === "Семейная фотография")!.url = "/media/evidence.png?download=1#scan";
    assert.deepEqual(normalized, expected);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", targetFamily.people[0].photo!.slice(7))), original);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", targetFamily.photos![0].url.slice(7))), original);
    const doc = await target.db.prepare("SELECT title,file_name,uploaded_by,document_type,document_date,place,description,provenance,annotations,pages FROM documents WHERE id=?").get(documentId);
    assert.equal(doc?.title, "Запись о семье");
    assert.equal(doc?.document_type, "Метрическая книга");
    assert.equal(doc?.document_date, "1900");
    assert.equal(doc?.place, "Тверь");
    assert.equal(doc?.description, "Семья Соколовых");
    assert.equal(doc?.provenance, "Государственный архив");
    assert.equal(doc?.uploaded_by, owner.id);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", String(doc?.file_name))), pdf);
    const transferredLegacy = await target.db.prepare(
      "SELECT id,file_name FROM documents WHERE id IN (?,?) ORDER BY id",
    ).all(legacyJpegId, legacyTiffId);
    assert.equal(transferredLegacy.length, 2);
    const legacyFiles = new Map(transferredLegacy.map((row) => [String(row.id), String(row.file_name)]));
    assert.deepEqual(await readFile(join(targetRoot, "uploads", legacyFiles.get(legacyJpegId)!)), legacyJpeg);
    assert.deepEqual(await readFile(join(targetRoot, "uploads", legacyFiles.get(legacyTiffId)!)), legacyTiff);
    assert.equal(storedDocumentFileType(legacyFiles.get(legacyJpegId)!)?.mime, "image/jpeg");
    assert.equal(storedDocumentFileType(legacyFiles.get(legacyTiffId)!)?.mime, "image/tiff");
    const restoredAnnotation = (JSON.parse(String(doc?.annotations)) as Array<{
      text: string; authorId: string; authorName: string;
    }>)[0];
    assert.equal(restoredAnnotation.text, "Строка о рождении");
    assert.equal(restoredAnnotation.authorId, "");
    assert.equal(restoredAnnotation.authorName, "Историк");
    assert.equal((JSON.parse(String(doc?.pages)) as Array<{ description: string }>)[0].description, "Лист 7: о семье");
    const documentLinks = await target.db.prepare(
      "SELECT document_id,person_id FROM document_people ORDER BY person_id",
    ).all();
    assert.deepEqual(documentLinks.filter((row) => row.document_id === documentId).map((row) => ({
      document_id: row.document_id, person_id: row.person_id,
    })), [family.people[1].id, family.people[0].id].map((person_id) => ({
      document_id: documentId, person_id,
    })));
    assert.ok(documentLinks.some((row) => row.document_id === legacyJpegId &&
      row.person_id === family.people[1].id));
    const eventLinks = await target.db.prepare("SELECT event_links FROM documents WHERE id=?").get(documentId);
    assert.deepEqual(JSON.parse(String(eventLinks?.event_links)),
      [{ personId: family.people[0].id, eventId, page: 1 }]);
    const comment = await target.db.prepare("SELECT text,author_id,author_name,created_ms,updated_ms,attachments FROM person_comments").get();
    assert.equal(comment?.text, "Проверено по книге");
    assert.equal(comment?.author_id, "");
    assert.equal(comment?.author_name, "Историк");
    assert.equal(comment?.created_ms, 1000);
    assert.equal(comment?.updated_ms, 2000);
    const restoredFiles = JSON.parse(String(comment?.attachments)) as Array<{ id: string; name: string }>;
    assert.equal(restoredFiles[0]?.name, "archive-note.txt");
    assert.deepEqual(await readFile(join(targetRoot, "uploads", "discussion-files", restoredFiles[0].id)), note);
    const attachmentOnlyComment = await target.db.prepare(
      "SELECT text,author_id,author_name,updated_ms,attachments FROM person_comments WHERE created_ms=3000",
    ).get();
    assert.equal(attachmentOnlyComment?.text, "");
    assert.equal(attachmentOnlyComment?.author_id, "");
    assert.equal(attachmentOnlyComment?.author_name, "Историк");
    assert.equal(attachmentOnlyComment?.updated_ms, null);
    const secondFile = (JSON.parse(String(attachmentOnlyComment?.attachments)) as Array<{ id: string; name: string }>)[0];
    assert.equal(secondFile.name, "transcription.txt");
    assert.deepEqual(await readFile(join(targetRoot, "uploads", "discussion-files", secondFile.id)),
      attachmentOnlyBytes);
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
