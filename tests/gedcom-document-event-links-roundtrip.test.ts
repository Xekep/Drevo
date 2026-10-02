import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { openArchive } from "../src/server/database.ts";
import { gedcomHttp } from "../src/server/gedcom-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { Family } from "../src/domain/types.ts";
import type { TransferMedia } from "../src/domain/genealogy-transfer.ts";

const family: Family = {
  title: "Архив", description: "", demo: false, photos: [],
  people: [{
    id: "parent", name: "Анна", surname: "Иванова", patronymic: "", sex: "f",
    birth: "1900", birthPlace: "", parents: [], spouses: [], sources: [],
    generation: 1, column: 0,
    events: [{ id: "residence-1905", type: "residence", place: "Тула" }],
  }],
};
const media: TransferMedia[] = [{
  id: "document", file: "documents/record.pdf", title: "Запись", mime: "application/pdf",
  personIds: ["parent"], portraitIds: [],
  document: {
    documentType: "record", documentDate: "1905", place: "Тула",
    description: "", provenance: "",
    eventLinks: [{ personId: "parent", eventId: "residence-1905", page: 3 }],
  },
}];

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} retains document-to-event links across person ID remapping`, () => {
    const restored = importGedcom(exportGedcom(family, { version, media }), `links-${version}`);
    assert.equal(restored.family.people[0].id, `links-${version}-p1`);
    assert.deepEqual(restored.media[0].document?.eventLinks, [{
      personId: restored.family.people[0].id, eventId: "residence-1905", page: 3,
    }]);
  });

test("GEDCOM 7 retains a document event link when a program renumbers person xrefs", () => {
  const text = exportGedcom(family, { version: "7.0", media }).replaceAll("@I1@", "@I42@");
  const restored = importGedcom(text, "renumbered");
  assert.deepEqual(restored.media[0].document?.eventLinks, [{
    personId: restored.family.people[0].id, eventId: "residence-1905", page: 3,
  }]);
});

test("GEDCOM 7 drops a document event link if its person or event was removed", () => {
  const withSecondPerson: Family = structuredClone(family);
  withSecondPerson.people.push({
    ...structuredClone(family.people[0]), id: "survivor", name: "Мария", events: [],
  });
  const text = exportGedcom(withSecondPerson, { version: "7.0", media });
  const missingPerson = importGedcom(
    text.replace(/0 @I1@ INDI[\s\S]*?(?=0 @I2@ INDI)/, ""), "missing-person");
  assert.equal(missingPerson.family.people.length, 1);
  assert.deepEqual(missingPerson.media[0].document?.eventLinks, []);
  assert.ok(missingPerson.warnings.some((warning) => warning.includes("событием документа")));

  const missingEvent = importGedcom(text.replace(
    '"eventId":"residence-1905"', '"eventId":"removed-event"'), "missing-event");
  assert.deepEqual(missingEvent.media[0].document?.eventLinks, []);
  assert.ok(missingEvent.warnings.some((warning) => warning.includes("событием документа")));
});

test("GEDCOM rejects malformed document event links", () => {
  const text = exportGedcom(family, { version: "7.0", media });
  assert.throws(() => importGedcom(text.replace('"page":3', '"page":0'), "bad-link"),
    /Повреждены сведения о медиа Drevo/);
});

test("GEDZIP restores the original PDF and its document-to-event link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedzip-event-links-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const original = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
    await writeFile(join(uploads, "record.pdf"), original);
    const path = join(directory, "archive.gdz");
    await writeGenealogyPackage(path, uploads, family, media);
    const restored = await prepareGenealogyImport(path, stage, "gedzip-link");
    assert.equal(restored.files.length, 1);
    assert.deepEqual(restored.files[0].document?.eventLinks, [{
      personId: restored.family.people[0].id, eventId: "residence-1905", page: 3,
    }]);
    assert.deepEqual(restored.files[0].personIds, [restored.family.people[0].id]);
    assert.deepEqual(await readFile(join(stage, restored.files[0].name)), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP GEDZIP import persists the remapped document-to-event link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-gedzip-event-http-"));
  const dbPath = join(directory, "archive.sqlite");
  const archive = await openArchive(dbPath, family);
  const auth = { currentUser: () => ({
    id: "admin", name: "Admin", role: "admin", approved: true, createdAt: "",
  }) } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = gedcomHttp(archive, auth, dbPath, "https://test.invalid");
  const server = createServer(async (req, res) => {
    await route.handle(req, res, new URL(req.url!, "https://test.invalid"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const uploads = join(directory, "source-uploads");
    await mkdir(uploads);
    await writeFile(join(uploads, "record.pdf"), "%PDF-1.4\n%%EOF");
    const path = join(directory, "archive.gdz");
    await writeGenealogyPackage(path, uploads, family, media);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Origin: "https://test.invalid", "X-Drevo-Import": "1" };
    const preview = await fetch(`${base}/api/gedcom/preview`, {
      method: "POST", headers, body: new Uint8Array(await readFile(path)),
    });
    assert.equal(preview.status, 200,
      preview.status === 200 ? "" : await preview.text());
    const { token } = await preview.json() as { token: string };
    const applied = await fetch(`${base}/api/gedcom/import`, {
      method: "POST", headers, body: JSON.stringify({ token, confirm: true }),
    });
    assert.equal(applied.status, 200, await applied.text());
    const row = await archive.db.prepare("SELECT event_links FROM documents").get();
    const links = JSON.parse(String(row?.event_links));
    assert.equal(links.length, 1);
    const restored = (await archive.read()).family.people.find((person) =>
      person.id === links[0].personId);
    assert.ok(restored?.events?.some((event) => event.id === links[0].eventId));
    assert.equal(links[0].page, 3);
  } finally {
    await route.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
