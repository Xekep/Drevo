import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport } from "../src/server/genealogy-package.ts";

for (const version of ["5.5.1", "7.0"] as const) test(
  `GEDCOM ${version} keeps evidence for primary and alternative names without claiming a birth surname`,
  () => {
    const external = `0 HEAD\n1 GEDC\n2 VERS ${version}\n1 CHAR UTF-8\n` +
      `0 @I1@ INDI\n1 NAME Anna /Petrova/\n2 SOUR @S1@\n3 PAGE p. 1\n` +
      `1 NAME Anna /Sidorova/\n2 TYPE AKA\n2 SOUR @S2@\n3 PAGE p. 2\n` +
      `1 NAME Anna /Ivanova/\n2 TYPE birth\n2 SOUR @S3@\n3 PAGE p. 3\n` +
      `0 @S1@ SOUR\n1 TITL Passport\n1 NOTE Original record note\n` +
      `0 @S2@ SOUR\n1 TITL Alias register\n` +
      `0 @S3@ SOUR\n1 TITL Birth register\n0 TRLR\n`;
    const first = importGedcom(external, `external-${version}`);
    const person = first.family.people[0];
    assert.deepEqual(person.sources.map((source) => [source.title, source.reference]), [
      ["Passport", "p. 1"], ["Alias register", "p. 2"],
    ]);
    assert.equal(person.maidenNameClaim?.sources[0].title, "Birth register");
    assert.ok(first.warnings.some((warning) => warning.includes("NAME.SOUR") &&
      warning.includes("точная привязка")));
    assert.match(person.sources[0].note || "", /Original record note/);
    assert.match(person.sources[0].note || "", /NAME 1: Anna \/Petrova\//);
    assert.match(person.sources[1].note || "", /TYPE: AKA/);

    const again = importGedcom(exportGedcom(first.family, { version }), `again-${version}`);
    assert.deepEqual(again.family.people[0].sources.map((source) =>
      [source.title, source.reference]), [
      ["Passport", "p. 1"], ["Alias register", "p. 2"],
    ]);
    assert.equal(again.family.people[0].maidenNameClaim?.sources[0].title, "Birth register");
    assert.deepEqual(again.family.people[0].sources.map((source) => source.note),
      person.sources.map((source) => source.note));
  },
);

test("GEDZIP retains a NAME.SOUR attachment and page after flattening name evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-name-citation-"));
  try {
    const stage = join(directory, "stage");
    await mkdir(stage);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
    const gedcom = [
      "0 HEAD", "1 GEDC", "2 VERS 7.0", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Anna /Petrova/",
      "1 NAME Anna /Sidorova/", "2 TYPE AKA", "2 SOUR @S1@", "3 PAGE p. 4",
      "3 OBJE @M1@", "3 _DREVO_DOCUMENT_PAGE 4",
      "0 @S1@ SOUR", "1 TITL Alias register",
      "0 @M1@ OBJE", "1 FILE media/record.pdf", "2 FORM application/pdf",
      "0 TRLR", "",
    ].join("\n");
    const path = join(directory, "family.gdz");
    const zip = new ZipFile();
    const writing = pipeline(zip.outputStream, createWriteStream(path));
    zip.addBuffer(Buffer.from(gedcom), "gedcom.ged");
    zip.addBuffer(pdf, "media/record.pdf");
    zip.end();
    await writing;

    const imported = await prepareGenealogyImport(path, stage, "name-citation");
    const citation = imported.family.people[0].sources[0];
    const document = imported.files[0];
    assert.equal(imported.family.people[0].sources.length, 1);
    assert.match(citation.note || "", /NAME 2: Anna \/Sidorova\//);
    assert.equal(citation.documentId, document.documentId);
    assert.equal(citation.documentPage, 4);
    assert.deepEqual(await readFile(join(stage, document.name)), pdf);
    assert.ok(!imported.warnings.some((warning) =>
      warning.includes("связь с документом не восстановлена")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
