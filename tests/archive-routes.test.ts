import test from "node:test";
import assert from "node:assert/strict";
import { archivePaths, archiveViewAt } from "../src/domain/archive-routes.ts";

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
    "/people/unknown",
    "/tree//",
    "/../tree",
    "//places",
  ])
    assert.equal(archiveViewAt(path), null);
});
