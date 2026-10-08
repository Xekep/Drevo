import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneDerivedCaches } from "../src/server/derived-cache-maintenance.ts";

test("cache pruning respects budgets, fresh publications and original/history files", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-cache-prune-"));
  const now = Date.now();
  const preview = join(root, "previews"),
    reader = join(root, "uploads", ".reader-cache");
  try {
    await mkdir(preview);
    await mkdir(reader, { recursive: true });
    const stale = `${"a".repeat(64)}-avatar-v3.webp`;
    const old = `${"b".repeat(64)}-thumb-v3.webp`;
    const fresh = `${"c".repeat(64)}-display-v3.webp`;
    const manifest = `${"d".repeat(64)}-v1.json`;
    const original = join(root, "uploads", "original.jpg");
    await writeFile(original, "preserve");
    for (const file of [stale, old, fresh, "unknown.webp", ".pending.tmp"])
      await writeFile(join(preview, file), "cache");
    await writeFile(join(reader, manifest), "[]");
    for (const path of [join(preview, stale), join(reader, manifest)])
      await utimes(
        path,
        (now - 31 * 86_400_000) / 1000,
        (now - 31 * 86_400_000) / 1000,
      );
    await utimes(
      join(preview, old),
      (now - 2 * 3_600_000) / 1000,
      (now - 2 * 3_600_000) / 1000,
    );
    assert.deepEqual(
      await pruneDerivedCaches(root, now, { previews: 1, manifests: 100 }),
      { removed: 3 },
    );
    assert.deepEqual(
      (await readdir(preview)).sort(),
      [".pending.tmp", fresh, "unknown.webp"].sort(),
    );
    assert.deepEqual(await readdir(reader), []);
    assert.ok((await readdir(join(root, "uploads"))).includes("original.jpg"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("cache maintenance does not traverse a redirected cache directory", async (t) => {
  if (process.platform === "win32")
    return t.skip("symlink needs Windows developer mode");
  const root = await mkdtemp(join(tmpdir(), "drevo-cache-link-"));
  try {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(
      join(outside, `${"a".repeat(64)}-avatar-v3.webp`),
      "original",
    );
    await symlink(outside, join(root, "previews"));
    assert.deepEqual(
      await pruneDerivedCaches(root, Date.now() + 40 * 86_400_000),
      { removed: 0 },
    );
    assert.equal((await readdir(outside)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
