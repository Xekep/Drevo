import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openPromise } from "yauzl";
import { openArchive } from "../../src/server/database.ts";
import { validateFamily } from "../../src/domain/validation.ts";
import type { Family } from "../../src/domain/types.ts";
import type { CommentAttachmentFile } from "../../src/shared/person-discussion.ts";
import type { PortableSnapshot } from "../../src/server/portable-package.ts";

export function portableDomainFixture(
  portableDocumentId: string,
  portableAnnotationId: string,
  portableAttachment: CommentAttachmentFile,
): PortableSnapshot {
  const portableCitation = { title: "Record", type: "archive", reference: "folio 2" };
  const portableFixture: PortableSnapshot = {
    family: {
      title: "Transferred", description: "Synthetic full-domain round-trip", demo: false,
      people: [{ id: "pg-portable-person", name: "Portable", surname: "Person",
        patronymic: "", sex: "u", birth: "1900", birthPlace: "Test town",
        parents: [], spouses: [], generation: 1, column: 0, sources: [
          { title: "PDF citation", type: "archive", reference: "", url: "/media/portable-citation.pdf#page=2" },
          { title: "TIFF citation", type: "archive", reference: "", url: "/media/portable-citation.tif?page=2" },
          { ...portableCitation, catalogId: "pg-portable-catalog", documentId: portableDocumentId,
            documentPage: 1, note: "Synthetic catalog" },
        ],
        createdBy: "owner", parentageComplete: true, needsReview: true,
        occupation: "Archivist", occupationClaim: { value: "Archivist",
          sources: [portableCitation], confidence: "probable" },
        birthDateClaim: { value: "1900", sources: [portableCitation], confidence: "confirmed" },
        birthPlaceClaim: { value: "Test town", sources: [portableCitation], confidence: "tentative" },
        factAlternatives: [{ id: "pg-alternative", field: "birthPlace", value: "Other town",
          sources: [portableCitation], confidence: "conflicting" }],
        awards: [{ id: "pg-award", name: "Research medal", awardDefinitionId: "test-medal",
          degreeId: "first", year: "2000", source: { title: "Award card" } }],
        photo: "/media/portable-portrait.png",
        events: [{ id: "pg-event", type: "residence", date: "1920", place: "Test town",
          dateClaim: { value: "1920", sources: [portableCitation], confidence: "confirmed" },
          placeClaim: { value: "Test town", sources: [portableCitation], confidence: "probable" },
          sources: [portableCitation] }],
      }, { id: "pg-portable-relative", name: "Relative", surname: "Person",
        patronymic: "", sex: "u", birth: "1901", birthPlace: "",
        parents: [], spouses: [], generation: 1, column: 1, sources: [] },
      { id: "pg-portable-twin", name: "Twin", surname: "Person",
        patronymic: "", sex: "u", birth: "1900", birthPlace: "",
        parents: [], spouses: [], generation: 1, column: 2, sources: [] }],
      unions: [{ id: "pg-union", participants: ["pg-portable-person", "pg-portable-relative"],
        type: "marriage", confidence: "probable", createdBy: "owner",
        formation: { date: "1920", sources: [portableCitation], confidence: "confirmed" },
        ongoing: { dateText: "circa 1930", sources: [portableCitation] },
        ending: { date: "1940", sources: [portableCitation], confidence: "tentative" } }],
      links: [{ id: "pg-link", from: "pg-portable-person", to: "pg-portable-twin",
        type: "twin", twinKind: "fraternal", confidence: "unknown",
        sources: [portableCitation], createdBy: "owner" }],
      photos: [{ id: "pg-photo", url: "/media/portable-portrait.png", title: "Record image",
        createdAt: "2026-09-30T00:00:00.000Z", takenAt: "1920", year: "1920",
        place: "Test town", event: "Family event", description: "Original TIFF",
        tags: [{ id: "pg-tag", personId: "pg-portable-person",
          x: 0.1, y: 0.1, width: 0.2, height: 0.2 }], createdBy: "owner" }],
    },
    documents: [{ id: portableDocumentId, title: "Portable record",
      fileName: "portable-record.pdf", uploadedBy: "owner",
      createdAt: "2026-09-30T00:00:00Z", documentType: "", documentDate: "",
      place: "Test town", description: "A synthetic record", provenance: "County archive",
      personIds: ["pg-portable-person"],
      eventLinks: [{ personId: "pg-portable-person", eventId: "pg-event", page: 1 }],
      pages: [{ number: 1, description: "Folio one" }],
      annotations: [{ id: portableAnnotationId, page: 1, x: 0.1, y: 0.1,
        width: 0.2, height: 0.2, text: "Source note", authorId: "owner",
        authorName: "Original researcher", createdAt: "2026-09-30T00:00:00Z" }] }],
    comments: [{ id: 1, personId: "pg-portable-person", authorId: "owner",
      authorName: "Historian", createdMs: 1000, editedMs: 2000,
      text: "Verified", attachments: [portableAttachment] }],
    sources: [{ id: "pg-portable-catalog", title: "Record", type: "archive", author: "Clerk",
      institution: "County office", archive: "County archive", fond: "1", opis: "2",
      delo: "3", sheet: "4", reference: "folio 2", url: "", accessedAt: "",
      description: "Synthetic catalog", documentIds: [portableDocumentId] }],
  };
  validateFamily(portableFixture.family);
  return portableFixture;
}

type RoundtripArgs = {
  oauthBase: string;
  directory: string;
  roundtripPath: string;
  roundtripSnapshot: PortableSnapshot;
  firstFamily: Family;
  fixture: PortableSnapshot;
  fallbackFamily: Family;
  citationPdf: Buffer;
  citationTiff: Buffer;
  portablePortrait: Buffer;
  portableAttachmentBytes: Buffer;
  portableDocumentId: string;
};

/** The second target starts as a distinct, empty PostgreSQL owner archive. */
export async function assertPortableSecondPgRoundtrip({
  oauthBase, directory, roundtripPath, roundtripSnapshot, firstFamily,
  fixture, fallbackFamily, citationPdf, citationTiff, portablePortrait, portableAttachmentBytes,
  portableDocumentId,
}: RoundtripArgs) {
  const transferred = { family: firstFamily };
  const portableFixture = fixture;
  const family = fallbackFamily;
  const secondStart = await fetch(oauthBase + "/auth/yandex", { redirect: "manual" });
  assert.equal(secondStart.status, 302);
  const secondState = new URL(secondStart.headers.get("location")!).searchParams.get("state");
  const secondCallback = await fetch(
    oauthBase + `/auth/yandex/callback?state=${secondState}&code=portable-target`,
    { headers: { Cookie: secondStart.headers.getSetCookie()[0].split(";")[0] },
      redirect: "manual" },
  );
  assert.equal(secondCallback.status, 303);
  const secondLocation = secondCallback.headers.get("location")!;
  const secondCookie = secondCallback.headers.getSetCookie()
    .find((value) => value.startsWith("drevo_session="))!.split(";")[0];
  const secondOwner = await fetch(oauthBase + secondLocation.replace(/\/tree$/, "/api/session"),
    { headers: { Cookie: secondCookie } }).then((response) => response.json());
  const secondHeaders = { Cookie: secondCookie, Origin: process.env.PUBLIC_ORIGIN!,
    "X-Drevo-Import": "1" };
  const secondPreview = await fetch(oauthBase + secondLocation.replace(/\/tree$/, "/api/drevo/preview"), {
    method: "POST", headers: secondHeaders, body: readFileSync(roundtripPath),
  });
  assert.equal(secondPreview.status, 200,
    secondPreview.status === 200 ? "" : await secondPreview.text());
  const secondPreviewData = await secondPreview.json();
  assert.equal(secondPreviewData.canImport, true);
  assert.equal(secondPreviewData.comments, 1);
  const secondApply = await fetch(oauthBase + secondLocation.replace(/\/tree$/, "/api/drevo/import"), {
    method: "POST", headers: { ...secondHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ token: secondPreviewData.token, confirm: true }),
  });
  assert.equal(secondApply.status, 200,
    secondApply.status === 200 ? "" : await secondApply.text());
  const secondFamily = (await fetch(oauthBase + secondLocation.replace(/\/tree$/, "/api/family"),
    { headers: { Cookie: secondCookie } }).then((response) => response.json())).family;
  const expectedSecondFamily = structuredClone(transferred.family);
  for (const index of [0, 1])
    expectedSecondFamily.people[0].sources[index].url = secondFamily.people[0].sources[index].url;
  expectedSecondFamily.people[0].photo = secondFamily.people[0].photo;
  expectedSecondFamily.photos![0].url = secondFamily.photos[0].url;
  assert.deepEqual(secondFamily, expectedSecondFamily,
    "PostgreSQL HTTP export, preview and apply preserve the full current family domain");
  const secondArchiveId = secondLocation.split("/")[2];
  const secondDbPath = join(directory, "archives", secondArchiveId, "source.sqlite");
  const secondArchive = await openArchive(secondDbPath, family, secondArchiveId);
  try {
    const secondCatalog = await secondArchive.db.prepare("", "SELECT data FROM source_catalog WHERE id=?")
      .get("pg-portable-catalog");
    assert.deepEqual(JSON.parse(String(secondCatalog?.data)), portableFixture.sources![0]);
    const secondDocument = await secondArchive.db.prepare("", `SELECT file_name,uploaded_by,
      provenance,event_links,pages,annotations FROM documents WHERE id=?`).get(portableDocumentId);
    assert.equal(secondDocument?.uploaded_by, secondOwner.user.id);
    assert.equal(secondDocument?.provenance, portableFixture.documents[0].provenance);
    assert.deepEqual(JSON.parse(String(secondDocument?.event_links)),
      portableFixture.documents[0].eventLinks);
    assert.deepEqual(JSON.parse(String(secondDocument?.pages)), portableFixture.documents[0].pages);
    assert.equal(JSON.parse(String(secondDocument?.annotations))[0].authorId, "");
    const secondComment = await secondArchive.db.prepare("", `SELECT author_id,author_name,
      text,created_ms,updated_ms,attachments FROM person_comments WHERE person_id=?`)
      .get("pg-portable-person");
    assert.equal(secondComment?.author_id, "");
    assert.equal(secondComment?.author_name, "Historian");
    assert.equal(secondComment?.text, "Verified");
    assert.equal(Number(secondComment?.created_ms), 1000);
    assert.equal(Number(secondComment?.updated_ms), 2000);
    const secondAttachment = JSON.parse(String(secondComment?.attachments))[0] as
      { id: string; name: string; type: string; size: number };
    assert.deepEqual({ name: secondAttachment.name, type: secondAttachment.type,
      size: secondAttachment.size }, { name: "research-note.txt", type: "text/plain",
      size: portableAttachmentBytes.length });
    const secondUploads = join(dirname(secondDbPath), "uploads");
    for (const [name, expectedBytes] of [
      [secondDocument?.file_name, Buffer.from("%PDF-1.4\nportable document")],
      [secondFamily.people[0].photo!.slice(7), portablePortrait],
      [secondFamily.people[0].sources[0].url!.slice(7).split(/[?#]/, 1)[0], citationPdf],
      [secondFamily.people[0].sources[1].url!.slice(7).split(/[?#]/, 1)[0], citationTiff],
      [join("discussion-files", secondAttachment.id), portableAttachmentBytes],
    ] as const) {
      const bytes = readFileSync(join(secondUploads, String(name)));
      assert.equal(createHash("sha256").update(bytes).digest("hex"),
        createHash("sha256").update(expectedBytes).digest("hex"));
    }
  } finally {
    await secondArchive.close();
  }
  const secondExport = await fetch(oauthBase +
    secondLocation.replace(/\/tree$/, "/api/drevo/export"),
  { headers: { Cookie: secondCookie } });
  assert.equal(secondExport.status, 200);
  const secondExportPath = join(directory, "portable-second-roundtrip.drevo");
  writeFileSync(secondExportPath, Buffer.from(await secondExport.arrayBuffer()));
  const secondZip = await openPromise(secondExportPath);
  let secondSnapshot: PortableSnapshot | undefined;
  for await (const entry of secondZip.eachEntry()) {
    if (entry.fileName !== "archive.json") continue;
    const chunks: Buffer[] = [];
    for await (const chunk of await secondZip.openReadStreamPromise(entry))
      chunks.push(Buffer.from(chunk));
    secondSnapshot = JSON.parse(Buffer.concat(chunks).toString()) as PortableSnapshot;
  }
  assert.ok(secondSnapshot);
  const expectedSecondSnapshot = structuredClone(roundtripSnapshot);
  expectedSecondSnapshot.family = expectedSecondFamily;
  expectedSecondSnapshot.documents[0].fileName = secondSnapshot.documents[0].fileName;
  expectedSecondSnapshot.documents[0].uploadedBy = secondOwner.user.id;
  expectedSecondSnapshot.documents[0].annotations[0].authorId = "";
  expectedSecondSnapshot.comments[0].id = secondSnapshot.comments[0].id;
  expectedSecondSnapshot.comments[0].attachments![0].id =
    secondSnapshot.comments[0].attachments![0].id;
  assert.deepEqual(secondSnapshot, expectedSecondSnapshot,
    "a second PostgreSQL HTTP export retains every portable field after import");
}
