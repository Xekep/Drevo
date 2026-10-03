import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

test("health release identity comes from the immutable release directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-release-"));
  const server = join(directory, "src", "server");
  mkdirSync(server, { recursive: true });
  const module = join(server, "runtime-release.ts");
  copyFileSync(
    new URL("../src/server/runtime-release.ts", import.meta.url),
    module,
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const run = () =>
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        "import {runtimeReleaseId} from './src/server/runtime-release.ts'; console.log(JSON.stringify(runtimeReleaseId))",
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  try {
    assert.equal(run(), "null");
    const releaseId = "a".repeat(40) + "-2";
    writeFileSync(
      join(directory, "release.json"),
      JSON.stringify({ releaseId }),
    );
    assert.equal(JSON.parse(run()), releaseId);
    writeFileSync(join(directory, "release.json"), '{"releaseId":"invalid"}');
    assert.throws(run);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
