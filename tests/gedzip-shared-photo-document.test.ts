import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Family } from "../src/domain/types.ts";
import { familyMedia, type TransferMedia } from "../src/domain/genealogy-transfer.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";

for (const documentFirst of [false, true]) test(
  `GEDZIP retains a gallery portrait and cited document sharing one original (${documentFirst ? "document first" : "photo first"})`,
  async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-gedzip-shared-media-"));
  try {
    const uploads = join(root, "uploads"), stage = join(root, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const original = await sharp({ create: { width: 2, height: 2, channels: 4,
      background: "#4286a4" } }).png().toBuffer();
    await writeFile(join(uploads, "shared.png"), original);
    const family: Family = {
      title: "Shared original", description: "", demo: false,
      photos: [{ id: "gallery-photo", url: "/media/shared.png", title: "Portrait",
        tags: [{ id: "tag", personId: "person", x: 0, y: 0, width: 1, height: 1 }] }],
      people: [{ id: "person", name: "Anna", surname: "Ivanova", patronymic: "",
        sex: "f", birth: "1900", birthPlace: "", parents: [], spouses: [],
        generation: 1, column: 0, photo: "/media/shared.png",
        sources: [{ title: "Registry scan", type: "archive", reference: "p. 2",
          documentId: "registry-document", documentPage: 2 }] }],
    };
    const document: TransferMedia = {
      id: "registry-document", file: "documents/shared.png", title: "Registry",
      personIds: ["person"], portraitIds: [],
      document: { documentType: "registry", documentDate: "1900", place: "",
        description: "", provenance: "" },
    };
    const path = join(root, "archive.gdz");
    const photos = familyMedia(family);
    await writeGenealogyPackage(path, uploads, family,
      documentFirst ? [document, ...photos] : [...photos, document]);
    const restored = await prepareGenealogyImport(path, stage, "shared-original");
    const person = restored.family.people[0];
    const photo = restored.family.photos?.[0];
    const stagedDocument = restored.files.find((item) => item.documentId);

    assert.equal(restored.files.length, 2);
    assert.equal(restored.family.photos?.length, 1);
    assert.ok(photo);
    assert.ok(stagedDocument);
    assert.equal(photo?.title, "Portrait");
    assert.equal(person.photo, photo?.url);
    assert.equal(person.sources[0].documentId, stagedDocument?.documentId);
    assert.equal(person.sources[0].documentPage, 2);
    assert.equal(stagedDocument?.document?.documentType, "registry");
    assert.ok(!restored.warnings.some((warning) =>
      warning.includes("связь с документом не восстановлена")));
    assert.deepEqual(await readFile(join(stage, photo!.url.slice(7))), original);
    assert.deepEqual(await readFile(join(stage, stagedDocument!.name)), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
