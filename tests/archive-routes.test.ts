import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveDocumentAt,
  archiveDocumentPath,
  archivePaths,
  archiveViewAt,
} from "../src/domain/archive-routes.ts";
import {
  archiveTargetAt,
  archiveTargetPath,
} from "../src/domain/archive-links.ts";

test("all archive sections have stable exact URLs shared by browser and server", () => {
  assert.equal(archiveViewAt("/"), "tree");
  for (const [view, path] of Object.entries(archivePaths)) {
    assert.equal(archiveViewAt(path), view);
    assert.equal(archiveViewAt(path + "/"), view);
  }
  assert.equal(archivePaths.list, "/people");
  assert.equal(archivePaths.gallery, "/photos");
  for (const path of [
    "/admin-secret",
    "/api/family",
    "/media/a.png",
    "/people/unknown/extra",
    "/photos/%ZZ",
    "/tree//",
    "/../tree",
    "//places",
  ])
    assert.equal(archiveViewAt(path), null);
});

test("profile and photo links retain their entity without changing section routes", () => {
  const person = { kind: "person" as const, id: "gedcom-Иван 1" };
  const photo = { kind: "photo" as const, id: "photo-42" };
  for (const target of [person, photo]) {
    const url = new URL(archiveTargetPath(target), "https://example.test");
    assert.equal(url.search, "");
    assert.deepEqual(archiveTargetAt(url.pathname, url.search), target);
    assert.equal(
      archiveViewAt(url.pathname),
      target.kind === "person" ? "tree" : "gallery",
    );
  }
  assert.deepEqual(archiveTargetAt("/tree", "?person=unknown"), {
    kind: "person",
    id: "unknown",
  });
  assert.equal(
    archiveTargetPath({ kind: "person", id: "unknown" }),
    "/people/unknown",
  );
  assert.equal(
    archiveTargetPath({ kind: "photo", id: "photo-42" }),
    "/photos/photo-42",
  );
  assert.deepEqual(archiveTargetAt("/photos", "?photo=photo-42"), {
    kind: "photo",
    id: "photo-42",
  });
  assert.equal(archiveTargetAt("/people", "?person=unknown"), null);
  assert.equal(archiveTargetAt("/photos", "?photo="), null);
  assert.equal(archiveTargetAt("/photos", `?photo=${"x".repeat(201)}`), null);
});

test("document routes preserve the optional person filter without query parameters", () => {
  const id = "14a064a7-6947-4089-9ad2-570b87978914";
  const personId = "gedcom-Иван 1";
  for (const [person, document] of [
    [null, null],
    [null, id],
    [personId, null],
    [personId, id],
  ] as const) {
    const path = archiveDocumentPath(person, document);
    assert.equal(new URL(path, "https://example.test").search, "");
    assert.deepEqual(archiveDocumentAt(path), {
      personId: person,
      documentId: document,
    });
    assert.equal(archiveViewAt(path), "documents");
    assert.deepEqual(archiveDocumentAt(`/a/other-tree${path}`), {
      personId: person,
      documentId: document,
    });
  }
  assert.equal(archiveDocumentAt("/documents/not-a-document"), null);
  assert.equal(archiveViewAt("/documents/not-a-document"), null);
  assert.equal(archiveDocumentAt("/documents/person/%ZZ"), null);
  for (const person of [null, personId]) {
    const path = archiveDocumentPath(person, id, 2);
    assert.deepEqual(archiveDocumentAt(path), {
      personId: person,
      documentId: id,
      pageNumber: 2,
    });
    assert.deepEqual(archiveDocumentAt(`/a/other-tree${path}`), {
      personId: person,
      documentId: id,
      pageNumber: 2,
    });
    assert.equal(archiveViewAt(path), "documents");
  }
  assert.equal(archiveDocumentAt(`/documents/${id}/page/0`), null);
  assert.equal(archiveDocumentAt(`/documents/${id}/page/2001`), null);
  assert.equal(archiveDocumentAt(`/documents/${id}/page/01`), null);
});
