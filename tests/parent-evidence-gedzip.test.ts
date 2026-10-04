import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family, Person } from "../src/domain/types.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { openArchive } from "../src/server/database.ts";
import { exportMedia, prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";

const documentId = "d0c00000-0000-4000-8000-000000000001";
const person = (id: string, sex: Person["sex"]): Person => ({
  id, name: id, surname: "Example", patronymic: "", sex,
  birth: "", birthPlace: "", parents: [], spouses: [],
  generation: 1, column: 0, sources: [],
});
const emptyFamily = (): Family => ({ title: "Parent evidence", description: "", demo: false,
  people: [person("father", "m"), person("mother", "f"), person("other", "u"),
    person("child", "u"), person("stranger", "u")] });
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("GEDCOM 5.5.1/7 and GEDZIP keep two cited parent edges, PDF pages and original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-parent-gedzip-"));
  const uploads = join(root, "uploads"), stage = join(root, "stage");
  await Promise.all([mkdir(uploads), mkdir(stage)]);
  const original = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const family = emptyFamily();
  const archive = await openArchive(join(root, "source.sqlite"), family);
  try {
    await writeFile(join(uploads, "parent-record.pdf"), original);
    await archive.db.prepare(`INSERT INTO documents
      (id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,
       document_date,place,description,provenance,annotations,event_links,pages)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      documentId, "Parent register", "parent register", "parent-record.pdf", original.length,
      "editor", "2026-01-01T00:00:00Z", "registry", "", "", "", "",
      "[]", "[]", "[]",
    );
    await sourceCatalogStore(archive.db).insert({
      id: "parent-register", title: "Parent register", type: "archive", author: "",
      institution: "", archive: "Synthetic archive", fond: "", opis: "", delo: "",
      sheet: "", reference: "leaf 12", url: "", accessedAt: "", description: "",
      documentIds: [documentId],
    });
    family.people[3].parents = ["father", "mother", "other"];
    family.people[3].parentClaims = [
      { parentId: "father", confidence: "confirmed", sources: [{
        catalogId: "parent-register", title: "Parent register", type: "archive",
        reference: "leaf 12", documentId, documentPage: 2,
      }] },
      { parentId: "other", confidence: "tentative", sources: [{
        title: "Separate parent note", type: "book", reference: "leaf 27",
        documentId, documentPage: 7,
      }] },
    ];
    await archive.write(family, (await archive.read()).revision);
    const stored = (await archive.read()).family;
    const media = await exportMedia(archive.db, stored);
    assert.equal(media.filter((item) => item.document).length, 1);

    for (const version of ["5.5.1", "7.0"] as const) {
      const text = exportGedcom(stored, { version, media });
      assert.match(text, /1 _DREVO_PARENT @I3@/);
      assert.match(text, /1 _DREVO_PARENT_CLAIM @I1@\r?\n2 _DREVO_PARENT_CONFIDENCE confirmed\r?\n2 SOUR @S\d+@/);
      assert.match(text, /1 _DREVO_PARENT_CLAIM @I3@\r?\n2 _DREVO_PARENT_CONFIDENCE tentative\r?\n2 SOUR @S\d+@/);
      assert.match(text, /3 _DREVO_DOCUMENT_PAGE 2/);
      assert.match(text, /3 _DREVO_DOCUMENT_PAGE 7/);
      assert.match(text, /1 _DREVO_CATALOG_LINK_LOST Y/);
      assert.doesNotMatch(text, /parent-register/,
        "GEDCOM exports the citation, not the archive-wide catalog record");
      const plain = importGedcom(text, `plain-${version}`);
      const child = plain.family.people.find((item) => item.name === "child")!;
      const byParent = new Map(child.parentClaims?.map((claim) => [
        plain.family.people.find((item) => item.id === claim.parentId)?.name, claim,
      ]));
      assert.equal(child.parents.length, 3);
      assert.deepEqual([...byParent.keys()].sort(), ["father", "other"]);
      assert.equal(byParent.get("father")?.sources?.[0].reference, "leaf 12");
      assert.equal(byParent.get("other")?.sources?.[0].reference, "leaf 27");
      const pendingPages = new Map(plain.citationMedia?.map((link) => [link.source, link.page]));
      assert.equal(pendingPages.get(byParent.get("father")!.sources![0]), 2);
      assert.equal(pendingPages.get(byParent.get("other")!.sources![0]), 7);
      assert.ok(plain.warnings.some((warning) => warning.includes("расширение Drevo")));
      assert.ok(plain.warnings.some((warning) => warning.includes("каталогом источников")));

      const unrelated = importGedcom(text.replace(
        "1 _DREVO_PARENT_CLAIM @I3@", "1 _DREVO_PARENT_CLAIM @I5@",
      ), `unrelated-${version}`);
      const unrelatedChild = unrelated.family.people.find((item) => item.name === "child")!;
      assert.equal(unrelatedChild.parents.length, 3);
      assert.equal(unrelatedChild.parentClaims?.length, 1,
        "a known XREF cannot create evidence on a non-parent edge");
      assert.ok(unrelated.warnings.some((warning) => warning.includes("прямой связи")));
    }

    const zip = join(root, "family.gdz");
    await writeGenealogyPackage(zip, uploads, stored, media);
    const restored = await prepareGenealogyImport(zip, stage, "parent-roundtrip");
    const child = restored.family.people.find((item) => item.name === "child")!;
    const byParent = new Map(child.parentClaims?.map((claim) => [
      restored.family.people.find((item) => item.id === claim.parentId)?.name, claim,
    ]));
    assert.equal(child.parents.length, 3);
    assert.deepEqual([...byParent.keys()].sort(), ["father", "other"]);
    assert.equal(byParent.get("father")?.confidence, "confirmed");
    assert.equal(byParent.get("other")?.confidence, "tentative");
    assert.equal(byParent.get("father")?.sources?.[0].catalogId, undefined);
    assert.equal(byParent.get("father")?.sources?.[0].reference, "leaf 12");
    assert.equal(byParent.get("father")?.sources?.[0].documentPage, 2);
    assert.equal(byParent.get("other")?.sources?.[0].title, "Separate parent note");
    assert.equal(byParent.get("other")?.sources?.[0].reference, "leaf 27");
    assert.equal(byParent.get("other")?.sources?.[0].documentPage, 7);
    const stagedDocument = restored.files.find((file) => file.documentId)!;
    assert.equal(restored.files.length, 1);
    assert.equal(byParent.get("father")?.sources?.[0].documentId, stagedDocument.documentId);
    assert.equal(byParent.get("other")?.sources?.[0].documentId, stagedDocument.documentId);
    assert.equal(sha256(await readFile(join(stage, stagedDocument.name))), sha256(original));
    assert.ok(restored.warnings.some((warning) => warning.includes("расширение Drevo")));
    assert.ok(restored.warnings.some((warning) => warning.includes("каталогом источников")));
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
