import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import sharp from "sharp";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { openArchive } from "../src/server/database.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { Family } from "../src/domain/types.ts";
import type { TransferMedia } from "../src/domain/genealogy-transfer.ts";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");

async function prepared(text: string, files: string[], extras: Array<{ name: string; bytes: Buffer }> = []) {
  const root = await mkdtemp(join(tmpdir(), "drevo-standard-event-media-"));
  const zipPath = join(root, "source.gdz"), stage = join(root, "stage");
  await mkdir(stage);
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(text), "gedcom.ged");
  for (const file of files) zip.addBuffer(pdf, `media/${file}`);
  for (const extra of extras) zip.addBuffer(extra.bytes, `media/${extra.name}`);
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(zipPath))
      .once("finish", resolve).once("error", reject);
    zip.end();
  });
  return { root, stage, zipPath, parsed: await prepareGenealogyImport(zipPath, stage, "event-media") };
}

test("standard event OBJE binds GEDZIP PDFs to their exact event nodes, including shared media", async () => {
  const source = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Ada /Example/",
    "1 RESI", "2 DATE 1 JAN 1900", "2 OBJE @M1@",
    "2 SOUR @S1@", "3 PAGE page 12", "3 OBJE @M1@",
    "1 RESI", "2 DATE 1 JAN 1900", "2 OBJE @M2@",
    "0 @I2@ INDI", "1 NAME Ben /Example/",
    "1 BIRT", "2 DATE 2 FEB 1901", "2 OBJE @M1@",
    "0 @M1@ OBJE", "1 FILE media/shared.pdf", "2 FORM application/pdf", "2 TITL Shared register",
    "0 @M2@ OBJE", "1 FILE media/second.pdf", "2 FORM application/pdf", "2 TITL Second register",
    "0 @S1@ SOUR", "1 TITL Residence register",
    "0 TRLR",
  ].join("\n");
  const { root, stage, parsed } = await prepared(source, ["shared.pdf", "second.pdf"]);
  try {
    const [ada, ben] = parsed.family.people;
    const residences = ada.events?.filter((event) => event.gedcomTag === "RESI") || [];
    assert.equal(residences.length, 2);
    const birth = ben.events?.find((event) => event.gedcomTag === "BIRT");
    assert.ok(birth);
    const shared = parsed.files.find((file) => file.title === "Shared register");
    const second = parsed.files.find((file) => file.title === "Second register");
    assert.ok(shared?.documentId);
    assert.ok(second?.documentId);
    assert.deepEqual(shared.personIds, [ada.id, ben.id]);
    assert.deepEqual(shared.document?.eventLinks, [
      { personId: ada.id, eventId: residences[0].id },
      { personId: ben.id, eventId: birth.id },
    ]);
    assert.deepEqual(second.document?.eventLinks, [
      { personId: ada.id, eventId: residences[1].id },
    ]);
    assert.equal(residences[0].sources?.[0]?.title, "Residence register");
    assert.equal(residences[0].sources?.[0]?.reference, "page 12");
    assert.equal(residences[0].sources?.[0]?.documentId, shared.documentId);
    const outbound: TransferMedia[] = parsed.files.map((file) => ({
      id: file.documentId!, file: `documents/${file.name}`, title: file.title,
      mime: "application/pdf", personIds: file.personIds, portraitIds: [],
      document: file.document,
    }));
    const zip = join(root, "roundtrip.gdz"), nextStage = join(root, "next-stage");
    await mkdir(nextStage);
    await writeGenealogyPackage(zip, stage, parsed.family, outbound);
    const restored = await prepareGenealogyImport(zip, nextStage, "second-import");
    const [restoredAda, restoredBen] = restored.family.people;
    const restoredResidences = restoredAda.events?.filter((event) => event.gedcomTag === "RESI") || [];
    const restoredBirth = restoredBen.events?.find((event) => event.gedcomTag === "BIRT");
    assert.ok(restoredBirth);
    const restoredShared = restored.files.find((file) => file.title === "Shared register");
    const restoredSecond = restored.files.find((file) => file.title === "Second register");
    assert.deepEqual(restoredShared?.document?.eventLinks, [
      { personId: restoredAda.id, eventId: restoredResidences[0].id },
      { personId: restoredBen.id, eventId: restoredBirth.id },
    ]);
    assert.deepEqual(restoredSecond?.document?.eventLinks, [
      { personId: restoredAda.id, eventId: restoredResidences[1].id },
    ]);
    assert.equal(restoredResidences[0].sources?.[0]?.title, "Residence register");
    assert.equal(restoredResidences[0].sources?.[0]?.reference, "page 12");
    assert.equal(restoredResidences[0].sources?.[0]?.documentId, restoredShared?.documentId);
    for (const file of parsed.files) {
      const match = restored.files.find((candidate) => candidate.title === file.title);
      assert.ok(match);
      assert.deepEqual(await readFile(join(nextStage, match.name)), await readFile(join(stage, file.name)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("family-event OBJE keeps participant access but warns when the event association cannot be mapped", async () => {
  const source = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0",
    "0 @I1@ INDI", "1 NAME Ada /Example/",
    "0 @I2@ INDI", "1 NAME Ben /Example/",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
    "1 MARR", "2 DATE 1 JAN 1900", "2 OBJE @M1@",
    "0 @M1@ OBJE", "1 FILE media/marriage.pdf", "2 FORM application/pdf", "2 TITL Marriage register",
    "0 TRLR",
  ].join("\n");
  const { root, parsed } = await prepared(source, ["marriage.pdf"]);
  try {
    assert.deepEqual(parsed.files[0].personIds, parsed.family.people.map((person) => person.id));
    assert.equal(parsed.files[0].document?.eventLinks?.length || 0, 0);
    assert.ok(parsed.warnings.some((warning) => /OBJE/.test(warning) && /событ/.test(warning)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Drevo metadata keeps its original document links when external EVENT.OBJE disagrees", async () => {
  const family: Family = {
    title: "Example", description: "", demo: false, photos: [],
    people: [{
      id: "person", name: "Ada", surname: "Example", patronymic: "", sex: "f",
      birth: "", birthPlace: "", parents: [], spouses: [], sources: [],
      generation: 1, column: 0,
      events: [
        { id: "first", type: "residence", date: "1900" },
        { id: "second", type: "residence", date: "1910" },
      ],
    }],
  };
  const media: TransferMedia[] = [{
    id: "record", file: "documents/record.pdf", title: "Record", mime: "application/pdf",
    personIds: ["person"], portraitIds: [],
    document: { documentType: "record", documentDate: "", place: "",
      description: "", provenance: "", eventLinks: [{ personId: "person", eventId: "first" }] },
  }];
  const text = exportGedcom(family, { version: "7.0", media });
  assert.match(text, /2 DATE 1910\r?\n/);
  const altered = text.replace(/2 DATE 1910\r?\n/, "$&2 OBJE @M1@\r\n")
    .replace("1 FILE documents/record.pdf", "1 FILE media/record.pdf");
  const { root, parsed } = await prepared(altered, ["record.pdf"]);
  try {
    assert.deepEqual(parsed.files[0].document?.eventLinks, [
      { personId: parsed.family.people[0].id, eventId: "first" },
    ]);
    assert.ok(parsed.warnings.some((warning) => warning.includes("EVENT.OBJE")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a photo used by EVENT.OBJE remains a photo with an explicit association warning", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 40, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();
  const source = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI", "1 NAME Ada /Example/",
    "1 BIRT", "2 DATE 1 JAN 1900", "2 OBJE @M1@",
    "0 @M1@ OBJE", "1 FILE media/portrait.png", "2 FORM image/png",
    "0 TRLR",
  ].join("\n");
  const { root, parsed } = await prepared(source, [], [{ name: "portrait.png", bytes: png }]);
  try {
    assert.equal(parsed.files[0].documentId, undefined);
    assert.deepEqual(parsed.files[0].personIds, [parsed.family.people[0].id]);
    assert.equal(parsed.family.photos?.length, 1);
    assert.ok(parsed.warnings.some((warning) => warning.includes("EVENT.OBJE")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain GEDCOM warns when the event-associated original is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-event-media-missing-"));
  try {
    const file = join(root, "source.ged"), stage = join(root, "stage");
    await mkdir(stage);
    await writeFile(file, [
      "0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI", "1 NAME Ada /Example/",
      "1 BIRT", "2 DATE 1 JAN 1900", "2 OBJE @M1@",
      "0 @M1@ OBJE", "1 FILE media/record.pdf", "2 FORM application/pdf",
      "0 TRLR",
    ].join("\n"));
    const parsed = await prepareGenealogyImport(file, stage, "missing-event-original");
    assert.equal(parsed.files.length, 0);
    assert.ok(parsed.warnings.some((warning) => warning.includes("отсутствует")));
    assert.ok(parsed.warnings.some((warning) => warning.includes("EVENT.OBJE")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event media without a resolvable FILE is called out in preview warnings", () => {
  const source = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI", "1 NAME Ada /Example/",
    "1 BIRT", "2 OBJE @VOID@", "2 OBJE @M1@",
    "0 @M1@ OBJE", "1 TITL Empty record", "0 TRLR",
  ].join("\n");
  const parsed = importGedcom(source, "empty-event-media");
  assert.ok(parsed.warnings.some((warning) => warning.includes("EVENT.OBJE") && warning.includes("@VOID@")));
  assert.ok(parsed.warnings.some((warning) => warning.includes("EVENT.OBJE") && warning.includes("FILE")));
});

test("HTTP GEDZIP preview and apply persist a standard event-media association", async () => {
  const source = [
    "0 HEAD", "1 GEDC", "2 VERS 7.0", "0 @I1@ INDI", "1 NAME Ada /Example/",
    "1 BIRT", "2 DATE 1 JAN 1900", "2 OBJE @M1@",
    "0 @M1@ OBJE", "1 FILE media/record.pdf", "2 FORM application/pdf",
    "0 TRLR",
  ].join("\n");
  const { root, zipPath } = await prepared(source, ["record.pdf"]);
  const archive = await openArchive(join(root, "archive.sqlite"), {
    title: "Target", description: "", demo: false, people: [], photos: [],
  });
  const auth = { currentUser: () => ({
    id: "admin", name: "Admin", role: "admin", approved: true, createdAt: "",
  }) } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = gedcomHttp(archive, auth, join(root, "archive.sqlite"), "https://test.invalid");
  const server = createServer(async (req, res) => {
    await route.handle(req, res, new URL(req.url!, "https://test.invalid"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Origin: "https://test.invalid", "X-Drevo-Import": "1" };
    const preview = await fetch(`${base}/api/gedcom/preview`, {
      method: "POST", headers, body: new Uint8Array(await readFile(zipPath)),
    });
    assert.equal(preview.status, 200, preview.status === 200 ? "" : await preview.text());
    const { token } = await preview.json() as { token: string };
    const applied = await fetch(`${base}/api/gedcom/import`, {
      method: "POST", headers, body: JSON.stringify({ token, confirm: true }),
    });
    assert.equal(applied.status, 200, await applied.text());
    const row = await archive.db.prepare("SELECT event_links FROM documents").get();
    const links = JSON.parse(String(row?.event_links));
    assert.equal(links.length, 1);
    const restored = (await archive.read()).family.people.find((person) => person.id === links[0].personId);
    assert.ok(restored?.events?.some((event) => event.id === links[0].eventId && event.gedcomTag === "BIRT"));
  } finally {
    await route.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
