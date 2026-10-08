import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveContextAt,
  archiveResourceUrl,
  memberPreviewAt,
  memberPreviewPath,
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

test("participant preview preserves its identity across views and read resources", () => {
  const memberId = "vk:42 Ирина";
  for (const archiveId of [null, "family-one"]) {
    const path = memberPreviewPath(archiveId, memberId);
    const preview = memberPreviewAt(path);
    assert.equal(preview?.memberId, memberId);
    assert.equal(preview?.archiveId, archiveId);
    assert.equal(preview?.innerPath, "/tree");
    assert.equal(archiveViewAt(path), "tree");
    assert.equal(scopedArchivePath("/people/person-1", path),
      `${preview!.prefix}/people/person-1`);
    assert.equal(scopedArchivePath(`${preview!.prefix}/people/person-1`, path),
      `${preview!.prefix}/people/person-1`);
    assert.equal(archiveResourceUrl("/api/documents?limit=6", path),
      `${preview!.prefix}/api/documents?limit=6`);
    assert.equal(archiveResourceUrl("/media/photo.png?variant=thumb", path),
      `${preview!.prefix}/media/photo.png?variant=thumb`);
    assert.equal(archiveResourceUrl(`${preview!.prefix}/media/photo.png`, path),
      `${preview!.prefix}/media/photo.png`);
    assert.equal(archiveResourceUrl("/a/other-tree/media/hidden.png", path),
      `${preview!.prefix}/api/unavailable`);
    assert.equal(archiveViewAt(`${preview!.prefix}/people/person-1`), "tree");
    assert.deepEqual(archiveTargetAt(`${preview!.prefix}/photos/photo-2`, ""),
      { kind: "photo", id: "photo-2" });
    assert.equal(archiveViewAt(`${preview!.prefix}/documents`), "documents");
    assert.equal(archiveViewAt(`${preview!.prefix}/manage`), null);
    assert.equal(`${archiveId ? `/a/${archiveId}` : ""}/manage`,
      archiveId ? "/a/family-one/manage" : "/manage");
  }
});

test("preview resource links cannot normalize into owner or another archive routes", () => {
  const origin = "https://drevo.example";
  for (const archiveId of [null, "family-one"]) {
    const path = memberPreviewPath(archiveId, "vk:42");
    const prefix = memberPreviewAt(path)!.prefix;
    const unavailable = `${prefix}/api/unavailable`;
    assert.equal(archiveResourceUrl("/api/family?projection=overview", path, origin),
      `${prefix}/api/family?projection=overview`);
    assert.equal(archiveResourceUrl(`${origin}/api/documents?limit=1`, path, origin),
      `${prefix}/api/documents?limit=1`);
    assert.equal(archiveResourceUrl(`//drevo.example/media/photo.png`, path, origin),
      `${prefix}/media/photo.png`);
    assert.equal(archiveResourceUrl(`${prefix}/media/photo.png`, path, origin),
      `${prefix}/media/photo.png`);
    for (const input of [
      "/media/../../../api/family", "/media/%2E%2E/%2e%2e/api/family",
      `${origin}/media/../../api/family`,
      `${prefix}/media/../../../../api/family`,
      "/a/other-tree/api/family", "/preview/other/api/family",
      `${origin}/account`,
    ]) assert.equal(archiveResourceUrl(input, path, origin), unavailable, input);
    assert.equal(archiveResourceUrl("https://external.example/archive.jpg", path, origin),
      "https://external.example/archive.jpg");
  }
});

test("invalid participant ids cannot form a preview route", () => {
  for (const id of [".", "..", "a/b", "a%b", "\n", "x".repeat(201)])
    assert.throws(() => memberPreviewPath(null, id));
  for (const path of ["/preview/%ZZ/tree", "/preview/%2F/tree", "/preview/%252F/tree",
    "/a/family-one/preview/../tree"])
    assert.equal(memberPreviewAt(path), null);
});
