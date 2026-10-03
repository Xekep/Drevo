import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { ZipFile } from "yazl";
import { importGedcom } from "../src/domain/gedcom.ts";
import type { TransferMedia } from "../src/domain/genealogy-transfer.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";

const external = `0 HEAD
1 SOUR OTHER
1 GEDC
2 VERS 7.0
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anna /Test/
1 SOUR @S1@
2 PAGE leaf 3
0 @S1@ SOUR
1 TITL Parish register
1 OBJE @M1@
0 @M1@ OBJE
1 FILE record.pdf
2 FORM application/pdf
2 TITL Register scan
0 TRLR`;

test("GEDCOM source-record scan stays attached to its citation", () => {
  const imported = importGedcom(external, "source-scan");
  const source = imported.family.people[0].sources[0];
  assert.equal(source.title, "Parish register");
  assert.equal(source.reference, "leaf 3");
  assert.equal(imported.media.length, 1);
  assert.ok(imported.citationMedia);
  assert.equal(imported.citationMedia.length, 1);
  assert.equal(imported.citationMedia[0].source, source);
  assert.equal(imported.citationMedia[0].mediaId, imported.media[0].id);
  assert.ok(imported.warnings.some((warning) => warning.includes("SOURCE_RECORD.OBJE")));
});

test("a shared source scan becomes one document attached to each citation", () => {
  const twoPeople = external.replace("0 @S1@ SOUR",
    "0 @I2@ INDI\n1 NAME Boris /Test/\n1 SOUR @S1@\n2 PAGE leaf 9\n0 @S1@ SOUR");
  const imported = importGedcom(twoPeople, "shared-source-scan");
  assert.equal(imported.media.length, 1);
  assert.ok(imported.citationMedia);
  assert.equal(imported.citationMedia.length, 2);
  assert.equal(imported.citationMedia[0].source, imported.family.people[0].sources[0]);
  assert.equal(imported.citationMedia[1].source, imported.family.people[1].sources[0]);
  assert.equal(imported.citationMedia[0].mediaId, imported.citationMedia[1].mediaId);
});

test("a citation's own scan takes precedence with a warning about the source-record scan", () => {
  const specific = external.replace("2 PAGE leaf 3", "2 PAGE leaf 3\n2 OBJE @M2@")
    .replace("0 TRLR", "0 @M2@ OBJE\n1 FILE page.pdf\n2 FORM application/pdf\n0 TRLR");
  const imported = importGedcom(specific, "specific-scan");
  assert.equal(imported.media.length, 2);
  assert.ok(imported.citationMedia);
  assert.equal(imported.citationMedia.length, 1);
  assert.equal(imported.citationMedia[0].mediaId,
    imported.media.find((item) => item.file === "page.pdf")?.id);
  assert.ok(imported.warnings.some((warning) =>
    warning.includes("SOURCE_RECORD.OBJE") && warning.includes("не привязано")));
});

test("GEDZIP stages one source-record scan for two citations and re-exports both links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-source-record-media-"));
  try {
    const firstStage = join(directory, "first-stage");
    const secondStage = join(directory, "second-stage");
    await mkdir(firstStage);
    await mkdir(secondStage);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3,
      background: "white" } }).png().toBuffer();
    const gedcom = external.replace("0 @S1@ SOUR",
      "0 @I2@ INDI\n1 NAME Boris /Test/\n1 SOUR @S1@\n2 PAGE leaf 9\n0 @S1@ SOUR")
      .replace("record.pdf", "media/scan.png")
      .replace("application/pdf", "image/png");
    const input = join(directory, "source.gdz");
    const zip = new ZipFile();
    const writing = pipeline(zip.outputStream, createWriteStream(input));
    zip.addBuffer(Buffer.from(gedcom), "gedcom.ged");
    zip.addBuffer(png, "media/scan.png");
    zip.end();
    await writing;

    const imported = await prepareGenealogyImport(input, firstStage, "source-record");
    assert.equal(imported.files.length, 1);
    const [first, second] = imported.family.people.map((person) => person.sources[0]);
    assert.ok(first.documentId);
    assert.equal(first.documentId, second.documentId);
    assert.deepEqual(await readFile(join(firstStage, imported.files[0].name)), png);
    assert.ok(imported.warnings.some((warning) => warning.includes("SOURCE_RECORD.OBJE")));

    const media: TransferMedia[] = [{ id: first.documentId,
      file: `documents/${imported.files[0].name}`, title: imported.files[0].title,
      personIds: [], portraitIds: [], document: imported.files[0].document! }];
    const exported = join(directory, "roundtrip.gdz");
    await writeGenealogyPackage(exported, firstStage, imported.family, media);
    const roundtrip = await prepareGenealogyImport(exported, secondStage, "source-record-again");
    assert.equal(roundtrip.files.length, 1);
    assert.equal(roundtrip.family.people[0].sources[0].documentId,
      roundtrip.family.people[1].sources[0].documentId);
    assert.deepEqual(roundtrip.family.people.map((person) => person.sources[0].reference),
      ["leaf 3", "leaf 9"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
