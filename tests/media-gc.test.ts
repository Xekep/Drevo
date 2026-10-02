import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pruneOrphanMedia } from "../src/server/media-gc.ts";

test("media GC removes only old unreferenced images", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-media-gc-")),
    db = new DatabaseSync(":memory:"),
    now = Date.now(),
    old = new Date(now - 48 * 60 * 60 * 1000),
    fresh = new Date(now - 60 * 60 * 1000);
  try {
    db.exec("CREATE TABLE people(data TEXT); CREATE TABLE photos(data TEXT); CREATE TABLE documents(file_name TEXT);");
    db.prepare("INSERT INTO documents(file_name) VALUES(?)").run("11111111-1111-4111-8111-111111111111.pdf");
    const referencedRasters = ["33333333-3333-4333-8333-333333333333.tif", "44444444-4444-4444-8444-444444444444.jpg"];
    for (const name of referencedRasters) {
      db.prepare("INSERT INTO documents(file_name) VALUES(?)").run(name);
      writeFileSync(join(dir, name), name);
      utimesSync(join(dir, name), old, old);
    }
    const orphanTiff = "55555555-5555-4555-8555-555555555555.tif";
    writeFileSync(join(dir, orphanTiff), orphanTiff);
    utimesSync(join(dir, orphanTiff), old, old);
    db.prepare("INSERT INTO people(data) VALUES(?)").run(
      JSON.stringify({ photo: "/media/referenced.jpg", sources: [
        { url: "/media/cited.pdf#page=2" },
      ], birthDateClaim: { sources: [{ url: "/media/cited.tif" }] } }),
    );
    db.prepare("INSERT INTO photos(data) VALUES(?)").run(
      JSON.stringify({ url: "/media/gallery.png" }),
    );

    for (const name of [
      "referenced.jpg",
      "cited.pdf",
      "cited.tif",
      "gallery.png",
      "old-orphan.webp",
      "fresh-orphan.gif",
      "notes.txt",
      "11111111-1111-4111-8111-111111111111.pdf",
      "22222222-2222-4222-8222-222222222222.pdf",
    ])
      writeFileSync(join(dir, name), name);

    for (const name of [
      "referenced.jpg",
      "cited.pdf",
      "cited.tif",
      "gallery.png",
      "old-orphan.webp",
      "notes.txt",
      "11111111-1111-4111-8111-111111111111.pdf",
      "22222222-2222-4222-8222-222222222222.pdf",
    ])
      utimesSync(join(dir, name), old, old);
    utimesSync(join(dir, "fresh-orphan.gif"), fresh, fresh);

    assert.deepEqual(pruneOrphanMedia(db, dir, { now }), [
      "22222222-2222-4222-8222-222222222222.pdf",
      orphanTiff,
      "old-orphan.webp",
    ]);
    assert.equal(existsSync(join(dir, "old-orphan.webp")), false);
    assert.equal(existsSync(join(dir, "referenced.jpg")), true);
    assert.equal(existsSync(join(dir, "cited.pdf")), true);
    assert.equal(existsSync(join(dir, "cited.tif")), true);
    assert.equal(existsSync(join(dir, "gallery.png")), true);
    assert.equal(existsSync(join(dir, "fresh-orphan.gif")), true);
    assert.equal(existsSync(join(dir, "notes.txt")), true);
    assert.equal(existsSync(join(dir, "11111111-1111-4111-8111-111111111111.pdf")), true);
    for (const name of referencedRasters) assert.ok(existsSync(join(dir, name)));
    assert.equal(existsSync(join(dir, orphanTiff)), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media GC treats a missing uploads directory as empty", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE people(data TEXT); CREATE TABLE photos(data TEXT);");
    assert.deepEqual(pruneOrphanMedia(db, "/definitely/missing/drevo/uploads"), []);
  } finally {
    db.close();
  }
});
