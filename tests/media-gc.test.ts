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
    db.exec("CREATE TABLE people(data TEXT); CREATE TABLE photos(data TEXT);");
    db.prepare("INSERT INTO people(data) VALUES(?)").run(
      JSON.stringify({ photo: "/media/referenced.jpg" }),
    );
    db.prepare("INSERT INTO photos(data) VALUES(?)").run(
      JSON.stringify({ url: "/media/gallery.png" }),
    );

    for (const name of [
      "referenced.jpg",
      "gallery.png",
      "old-orphan.webp",
      "fresh-orphan.gif",
      "notes.txt",
    ])
      writeFileSync(join(dir, name), name);

    for (const name of [
      "referenced.jpg",
      "gallery.png",
      "old-orphan.webp",
      "notes.txt",
    ])
      utimesSync(join(dir, name), old, old);
    utimesSync(join(dir, "fresh-orphan.gif"), fresh, fresh);

    assert.deepEqual(pruneOrphanMedia(db, dir, { now }), ["old-orphan.webp"]);
    assert.equal(existsSync(join(dir, "old-orphan.webp")), false);
    assert.equal(existsSync(join(dir, "referenced.jpg")), true);
    assert.equal(existsSync(join(dir, "gallery.png")), true);
    assert.equal(existsSync(join(dir, "fresh-orphan.gif")), true);
    assert.equal(existsSync(join(dir, "notes.txt")), true);
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
