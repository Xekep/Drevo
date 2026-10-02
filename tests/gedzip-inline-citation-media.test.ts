import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Family } from "../src/domain/types.ts";
import { exportGedcom } from "../src/domain/gedcom.ts";
import { openArchive } from "../src/server/database.ts";
import { exportMedia, prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { recordMediaOriginal } from "../src/server/media-originals.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";

const imageName = "b17b339b-3051-4859-872f-f29174494f43.png";
const documentId = "b17b339b-3051-4859-872f-f29174494f44";
const family: Family = {
  title: "Citation originals", description: "", demo: false, photos: [],
  people: [{
    id: "person", name: "Anna", surname: "Ivanova", patronymic: "", sex: "f",
    birth: "1900", birthPlace: "", parents: [], spouses: [], generation: 1, column: 0,
    sources: [
      { title: "Scan", type: "archive", reference: "page 1", url: `/media/${imageName}?download=1#detail` },
      { title: "Scan and register", type: "archive", reference: "page 2",
        url: `/media/${imageName}#page-2`, documentId, documentPage: 1 },
      { title: "Remote index", type: "web", reference: "", url: "https://example.test/index" },
    ],
  }],
};

test("GEDZIP restores inline citation originals and a separate cited document", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-gedzip-inline-"));
  const uploads = join(root, "uploads"), stage = join(root, "stage");
  await mkdir(uploads);
  await mkdir(stage);
  const png = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: "#5a79ad" } }).png().toBuffer();
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
  const archive = await openArchive(join(root, "source.sqlite"), family);
  try {
    await writeFile(join(uploads, imageName), png);
    await recordMediaOriginal(archive.db, `/media/${imageName}`, png.length, "owner");
    await writeFile(join(uploads, "record.pdf"), pdf);
    await archive.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
       document_date,place,description,provenance,annotations,event_links,pages)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      documentId, "Register", "register", "record.pdf", pdf.length, "owner",
      "2026-01-01T00:00:00Z", "", "", "", "", "", "[]", "[]", "[]",
    );
    const media = await exportMedia(archive.db, family);
    assert.equal(media.filter((item) => item.citationOnly).length, 1);
    const zip = join(root, "family.gdz");
    await writeGenealogyPackage(zip, uploads, family, media);
    const restored = await prepareGenealogyImport(zip, stage, "inline-citation");
    const sources = restored.family.people[0].sources;
    const localUrl = sources[0].url!;
    assert.match(localUrl, /^\/media\/[a-f0-9-]+\.png\?download=1#detail$/);
    assert.deepEqual(await readFile(join(stage, localUrl.slice(7).split("?")[0])), png);
    assert.equal(sources[1].url, localUrl.replace("?download=1#detail", "#page-2"));
    assert.ok(sources[1].documentId);
    assert.equal(sources[1].documentPage, 1);
    assert.equal(sources[2].url, "https://example.test/index");
    assert.equal(restored.family.photos?.length, 0,
      "citation-only image must not become a gallery photo");
    assert.equal(restored.files.length, 2);
    assert.deepEqual(await readFile(join(stage, restored.files.find((file) => file.documentId)?.name || "")), pdf);

    const plain = join(root, "family.ged"), plainStage = join(root, "plain-stage");
    await mkdir(plainStage);
    await writeFile(plain, exportGedcom(family, { version: "7.0", media }));
    const withoutFiles = await prepareGenealogyImport(plain, plainStage, "inline-text-only");
    assert.equal(withoutFiles.family.people[0].sources[0].url, undefined);
    assert.ok(withoutFiles.warnings.some((warning) => warning.includes("локальная ссылка цитаты не восстановлена")));
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GEDZIP refuses a missing local citation original before writing a package", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-gedzip-missing-"));
  const uploads = join(root, "uploads");
  await mkdir(uploads);
  const archive = await openArchive(join(root, "source.sqlite"), family);
  try {
    await recordMediaOriginal(archive.db, `/media/${imageName}`, 123, "owner");
    const media = await exportMedia(archive.db, family);
    const zip = join(root, "family.gdz");
    await assert.rejects(writeGenealogyPackage(zip, uploads, family, media),
      (error: Error) => error.message.includes("отсутствует в хранилище Drevo") &&
        !error.message.includes(root));
    await assert.rejects(stat(zip), /ENOENT/);

    const auth = { currentUser: () => ({ id: "owner", name: "Owner", role: "admin",
      approved: true, createdAt: "" }) } as unknown as Awaited<ReturnType<typeof createAuth>>;
    const route = gedcomHttp(archive, auth, join(root, "source.sqlite"));
    const server = createServer((req, res) => {
      void route.handle(req, res, new URL(req.url!, "http://localhost"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const response = await fetch(`${base}/api/gedcom/export?format=gedcom7`);
      assert.equal(response.status, 400);
      const body = await response.text();
      assert.match(body, /Оригинал источника отсутствует/);
      assert.ok(!body.includes(`/media/${imageName}`) && !body.includes(root));
    } finally {
      await route.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GEDZIP does not export a citation file outside the selected archive inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-gedzip-unowned-"));
  const uploads = join(root, "uploads");
  await mkdir(uploads);
  const archive = await openArchive(join(root, "source.sqlite"), family);
  try {
    await writeFile(join(uploads, imageName), await sharp({ create: {
      width: 2, height: 2, channels: 4, background: "#5a79ad",
    } }).png().toBuffer());
    await assert.rejects(exportMedia(archive.db, family), /не принадлежит выбранному архиву/);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
