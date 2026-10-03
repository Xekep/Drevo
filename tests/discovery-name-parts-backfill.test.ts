import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("name-parts backfill recognizes a direct CLI run through the release symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-discovery-backfill-"));
  const alias = join(directory, "current");
  try {
    symlinkSync(fileURLToPath(new URL("../ops/postgres/", import.meta.url)), alias, "junction");
    const result = spawnSync(process.execPath, ["--experimental-strip-types",
      join(alias, "backfill-discovery-name-parts.ts")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Use --apply for the opt-in name-parts backfill/);
  } finally {
    try { unlinkSync(alias); } catch { /* the junction may not have been created */ }
    rmdirSync(directory);
  }
});
