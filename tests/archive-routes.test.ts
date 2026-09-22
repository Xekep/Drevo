import test from "node:test";
import assert from "node:assert/strict";
import { archivePaths, archiveViewAt } from "../src/domain/archive-routes.ts";
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
