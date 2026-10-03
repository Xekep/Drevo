import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage, type PortableSnapshot } from "../src/server/portable-package.ts";

test("v1 preview rejects unknown archival sections instead of silently dropping them", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-unknown-section-"));
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  await writeFile(join(root, "record.pdf"),
    "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
  const base: PortableSnapshot = {
    family: { title: "Archive", description: "", demo: false, people: [{
      id: "person-1", surname: "Archive", name: "Person", patronymic: "",
      sex: "u", birth: "", birthPlace: "", parents: [], spouses: [],
      generation: 1, column: 0, sources: [],
    }] },
    documents: [{ id: "document-1", title: "Record", fileName: "record.pdf",
      createdAt: "2026-10-01T00:00:00Z", uploadedBy: "source-owner",
      documentType: "", documentDate: "", place: "", description: "",
      provenance: "", annotations: [], personIds: ["person-1"],
      eventLinks: [], pages: [] }],
    comments: [{ id: 1, personId: "person-1", authorId: "source-owner",
      authorName: "Author", createdMs: 1000, text: "Research note", attachments: [] }],
    sources: [],
  };
  const cases: Array<[string, (snapshot: PortableSnapshot) => void]> = [
    ["archive.json", (snapshot) => {
      (snapshot as PortableSnapshot & { researchRecords: unknown[] }).researchRecords =
        [{ title: "Unrecognized evidence" }];
    }],
    ["family", (snapshot) => {
      (snapshot.family as typeof snapshot.family & { familyNotes: string }).familyNotes =
        "Unrecognized family metadata";
    }],
    ["sources", (snapshot) => {
      snapshot.sources = [{ id: "source-1", title: "Register", type: "archive", author: "",
        institution: "", archive: "", fond: "", opis: "", delo: "", sheet: "",
        reference: "", url: "", accessedAt: "", description: "", documentIds: [],
        futureEvidence: "must not disappear",
      } as NonNullable<PortableSnapshot["sources"]>[number]];
    }],
    ["documents", (snapshot) => {
      (snapshot.documents[0] as typeof snapshot.documents[number] & { recordLayer: string })
        .recordLayer = "unknown";
    }],
    ["comments", (snapshot) => {
      (snapshot.comments[0] as typeof snapshot.comments[number] & { reviewFlag: string })
        .reviewFlag = "unknown";
    }],
  ];
  try {
    for (const [section, addUnknown] of cases) {
      const snapshot = structuredClone(base);
      addUnknown(snapshot);
      const path = join(root, `${section.replace(".", "-")}.drevo`);
      await writePortablePackage(createWriteStream(path), root, snapshot, async () => {});
      await assert.rejects(readPortablePackage(path, extracted),
        (error: Error) => error.message.includes("неподдерживаемые поля") &&
          error.message.includes(section), section);
    }
    const unknownAttachment = structuredClone(base);
    unknownAttachment.comments[0].attachments = [{
      id: "4d174aba-385c-4944-8943-47b151bd6c13", name: "note.txt",
      type: "text/plain", size: 4, futureDescription: "Must not disappear",
    } as NonNullable<PortableSnapshot["comments"][number]["attachments"]>[number]];
    await mkdir(join(root, "discussion-files"));
    await writeFile(join(root, "discussion-files", "4d174aba-385c-4944-8943-47b151bd6c13"), "note");
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    await assert.rejects(writePortablePackage(output, root, unknownAttachment,
      async () => {}), /неподдерживаемые поля.*вложения/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 preview rejects unknown attachment metadata that installation would erase", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-attachment-compatibility-"));
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  const id = "4d174aba-385c-4944-8943-47b151bd6c13";
  const attachment = Buffer.from("note");
  const archive = Buffer.from(JSON.stringify({
    family: { title: "Archive", description: "", demo: false, people: [{
      id: "person-1", surname: "Archive", name: "Person", patronymic: "",
      sex: "u", birth: "", birthPlace: "", parents: [], spouses: [],
      generation: 1, column: 0, sources: [],
    }] },
    documents: [], sources: [], comments: [{ id: 1, personId: "person-1",
      authorId: "source-owner", authorName: "Author", createdMs: 1000,
      text: "", attachments: [{ id, name: "note.txt", type: "text/plain",
        size: attachment.length, futureDescription: "Must not disappear" }] }],
  }));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const path = join(root, "attachment.drevo");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ format: "drevo", version: 1,
    exportedAt: "2026-10-04T00:00:00Z", entries: [
      { path: "archive.json", size: archive.length, sha256: hash(archive) },
      { path: `media/discussion-files/${id}`, size: attachment.length,
        sha256: hash(attachment) },
    ] })), "manifest.json");
  zip.addBuffer(archive, "archive.json");
  zip.addBuffer(attachment, `media/discussion-files/${id}`);
  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(path));
    await assert.rejects(readPortablePackage(path, extracted),
      /неподдерживаемые поля.*comments\.attachments/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
