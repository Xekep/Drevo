import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family } from "../src/domain/types.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { openArchive } from "../src/server/database.ts";
import { exportMedia, prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";

const documentId = "d0c00000-0000-4000-8000-000000000001";
const original = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const family = (): Family => ({ title: "Награда", description: "", demo: false,
  people: [{ id: "hero", name: "Иван", surname: "Примеров", patronymic: "",
    sex: "m", birth: "", birthPlace: "", parents: [], spouses: [],
    generation: 1, column: 0, sources: [], awards: [{ id: "medal", name: "Медаль",
      source: { title: "Прежняя карточка", url: "https://example.test/legacy" },
      sources: [
        { catalogId: "award-register", title: "Наградная книга", type: "архив",
          reference: "л. 2", documentId, documentPage: 2 },
        { title: "Второй лист", type: "архив", reference: "л. 7",
          documentId, documentPage: 7 },
      ] }] }] });

test("B writer exports award-bound GEDCOM 5/7 citations and GEDZIP PDF bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "award-gedzip-"));
  const uploads = join(root, "uploads"), stage = join(root, "stage");
  await Promise.all([mkdir(uploads), mkdir(stage)]);
  const archive = await openArchive(join(root, "archive.sqlite"), { ...family(), people: [] });
  try {
    await writeFile(join(uploads, "award-register.pdf"), original);
    await archive.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
       document_date,place,description,provenance,annotations,event_links,pages)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      documentId, "Наградная книга", "наградная книга", "award-register.pdf",
      original.length, "owner", "2026-01-01T00:00:00Z", "", "", "", "", "",
      "[]", "[]", "[]",
    );
    await sourceCatalogStore(archive.db).insert({ id: "award-register",
      title: "Наградная книга", type: "архив", author: "", institution: "",
      archive: "", fond: "", opis: "", delo: "", sheet: "",
      reference: "л. 2", url: "", accessedAt: "", description: "",
      documentIds: [documentId] });
    const written = await archive.write(family(), (await archive.read()).revision);
    const award = written.family.people[0].awards![0];
    assert.equal(award.sources?.length, 2);
    const media = await exportMedia(archive.db, written.family);
    assert.equal(media.filter((item) => item.document).length, 1);
    for (const version of ["5.5.1", "7.0"] as const) {
      const text = exportGedcom(written.family, { version, media });
      assert.match(text, /2 _DREVO_AWARD_ID medal/);
      assert.match(text, /2 _DREVO_DOCUMENT_PAGE 2/);
      assert.match(text, /2 _DREVO_DOCUMENT_PAGE 7/);
      assert.doesNotMatch(text, /"catalogId"|d0c00000-0000-4000-8000-000000000001/);
      const parsed = importGedcom(text, `award-${version}`);
      assert.equal(parsed.family.people[0].awards?.[0].sources?.length, 2);
      assert.equal(parsed.family.people[0].awards?.[0].source?.title, "Прежняя карточка");
      assert.ok(parsed.warnings.some((warning) => warning.includes("каталогом источников")));
    }
    const zip = join(root, "award.gdz");
    await writeGenealogyPackage(zip, uploads, written.family, media);
    const restored = await prepareGenealogyImport(zip, stage, "award-roundtrip");
    const citations = restored.family.people[0].awards?.[0].sources;
    assert.deepEqual(citations?.map((source) => source.documentPage), [2, 7]);
    assert.deepEqual(citations?.map((source) => source.reference), ["л. 2", "л. 7"]);
    assert.equal(citations?.[0].catalogId, undefined);
    assert.equal(restored.family.people[0].awards?.[0].source?.url,
      "https://example.test/legacy");
    const file = restored.files.find((item) => item.documentId);
    assert.ok(file);
    assert.equal(citations?.[0].documentId, file.documentId);
    assert.equal(citations?.[1].documentId, file.documentId);
    assert.equal(hash(await readFile(join(stage, file.name))), hash(original));
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
