import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDeletionDirectory,
  markArchiveForDeletion,
  removeDeletedArchiveFiles,
} from "../src/server/archive-deletion-files.ts";

test("archive file deletion requires an exact marked archive directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "drevo-archive-deletion-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "drevo.sqlite");
  const target = archiveDeletionDirectory(
    databasePath,
    "target-archive",
  ).directory;
  const sibling = archiveDeletionDirectory(
    databasePath,
    "other-archive",
  ).directory;
  await mkdir(target, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(target, "photo.jpg"), "private");
  await writeFile(join(sibling, "photo.jpg"), "keep");

  assert.throws(() => archiveDeletionDirectory(databasePath, "../outside"));
  await assert.rejects(
    removeDeletedArchiveFiles(databasePath, "target-archive"),
  );
  assert.equal(existsSync(target), true);
  await markArchiveForDeletion(target, "target-archive");
  await removeDeletedArchiveFiles(databasePath, "target-archive");
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(sibling, "photo.jpg")), true);
});
