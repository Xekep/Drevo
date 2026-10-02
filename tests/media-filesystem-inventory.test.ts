import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventoryMediaFiles } from "../ops/postgres/media-filesystem-inventory.ts";

function manifest(...rows: object[]) {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("inventory reconciles separate archive media without treating files as deletable", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-media-inventory-"));
  try {
    await mkdir(join(root, "uploads"));
    await mkdir(join(root, "archives", "tree-b", "uploads"), { recursive: true });
    await mkdir(join(root, "archives", "old-tree", "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "one.jpg"), "abc");
    await writeFile(join(root, "uploads", "old.png"), "history");
    await writeFile(join(root, "uploads", "stage-only.jpg"), "restore");
    await writeFile(join(root, "uploads", "old.pdf"), "document");
    await writeFile(join(root, "uploads", "cited.tif"), "citation");
    await writeFile(join(root, "uploads", "untracked.png"), "orphan?");
    await writeFile(join(root, "archives", "tree-b", "uploads", "one.jpg"), "x");
    const data = manifest(
      { kind: "archive", archive_id: "legacy-primary" },
      { kind: "archive", archive_id: "tree-b" },
      { kind: "ref", archive_id: "legacy-primary", name: "one.jpg", source: "person", known_bytes: null },
      { kind: "ref", archive_id: "legacy-primary", name: "one.jpg", source: "image_metadata", known_bytes: 3 },
      { kind: "ref", archive_id: "legacy-primary", name: "old.png", source: "history", known_bytes: null },
      { kind: "ref", archive_id: "legacy-primary", name: "stage-only.jpg", source: "restore_stage_image", known_bytes: null },
      { kind: "ref", archive_id: "legacy-primary", name: "old.pdf", source: "restore_stage_document", known_bytes: 8 },
      { kind: "ref", archive_id: "legacy-primary", name: "cited.tif", source: "citation", known_bytes: null },
      { kind: "ref", archive_id: "legacy-primary", name: "missing.pdf", source: "document", known_bytes: 20 },
      { kind: "ref", archive_id: "tree-b", name: "one.jpg", source: "photo", known_bytes: 2 },
    );
    const report = await inventoryMediaFiles(root, "legacy-primary", data);
    assert.deepEqual(report.results.map(({ archiveId, files, references }) =>
      [archiveId, files, references]), [
      ["legacy-primary", 6, 6], ["tree-b", 1, 1],
    ]);
    assert.deepEqual(report.results[0].missing, ["missing.pdf"]);
    assert.deepEqual(report.results[0].untracked, ["untracked.png"]);
    assert.deepEqual(report.results[1].sizeMismatches, ["one.jpg"]);
    assert.deepEqual(report.unknownArchiveDirectories, ["old-tree"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory rejects an incomplete or unsafe manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-media-inventory-"));
  try {
    await assert.rejects(inventoryMediaFiles(root, "legacy-primary", ""), /missing from manifest/);
    await assert.rejects(inventoryMediaFiles(root, "legacy-primary", manifest(
      { kind: "archive", archive_id: "legacy-primary" },
      { kind: "ref", archive_id: "legacy-primary", name: "../private.pdf", source: "document", known_bytes: 2 },
    )), /Invalid media reference/);
    await assert.rejects(inventoryMediaFiles(root, "legacy-primary", manifest(
      { kind: "archive", archive_id: "legacy-primary" },
      { kind: "ref", archive_id: "other-tree", name: "one.jpg", source: "person", known_bytes: null },
    )), /Unknown archive/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
