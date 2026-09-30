import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveContextAt,
  archiveResourceUrl,
  scopedArchivePath,
} from "../src/domain/archive-context.ts";
import { archiveViewAt } from "../src/domain/archive-routes.ts";
import { archiveTargetAt } from "../src/domain/archive-links.ts";

test("each archive tab keeps API, media and person links in its own path", () => {
  const first = "/a/family-one/people/person-1";
  const second = "/a/family-two/tree";
  assert.equal(archiveContextAt(first)?.id, "family-one");
  assert.equal(archiveViewAt(first), "tree");
  assert.deepEqual(archiveTargetAt(first, ""), {
    kind: "person",
    id: "person-1",
  });
  assert.equal(
    archiveResourceUrl("/api/family?projection=overview", first),
    "/a/family-one/api/family?projection=overview",
  );
  assert.equal(
    archiveResourceUrl("/media/same.png", second),
    "/a/family-two/media/same.png",
  );
  assert.equal(
    scopedArchivePath("/photos/photo-2", second),
    "/a/family-two/photos/photo-2",
  );
  assert.equal(
    scopedArchivePath("/a/family-one/tree", second),
    "/a/family-one/tree",
  );
});

test("public and root routes remain outside an archive", () => {
  assert.equal(archiveContextAt("/a/invalid%2Fid/tree"), null);
  assert.equal(
    archiveResourceUrl("/api/discover", "/discover"),
    "/api/discover",
  );
  assert.equal(
    archiveResourceUrl("https://example.org/photo", "/a/family-one/tree"),
    "https://example.org/photo",
  );
  assert.equal(archiveViewAt("/a/family-one/documents"), "documents");
});
