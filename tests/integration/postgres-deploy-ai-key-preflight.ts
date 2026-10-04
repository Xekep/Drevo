import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { aiProviderCleanup, providerCleanupKeyPaths } from "../../src/server/ai-provider-cleanup.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

/** Exercise two isolated runtime starts against a nonempty restored-style ledger. */
export async function verifyDeployAiKeyPreflight(db: StoreDatabase, configuredPath: string) {
  const source = providerCleanupKeyPaths(configuredPath);
  const ledger = await aiProviderCleanup(db, configuredPath, async () => {
    throw new Error("provider HTTP forbidden in preflight fixture");
  });
  const ref = await ledger.register(`preflight-${randomUUID()}`, "fixture-provider-id", {
    baseUrl: "http://127.0.0.1:1", folderId: "fixture-folder", apiKey: "fixture-key",
  });
  await ledger.pending(ref);
  const stage = mkdtempSync(join(tmpdir(), "drevo-provider-preflight-"));
  const python = process.platform === "win32" ? "python" : "python3";
  const release = resolve(".");
  const environment = { ...process.env, DATABASE_BACKEND: "postgres",
    ARCHIVE_ID: db.archiveId!, PUBLIC_ORIGIN: "https://migration-check.invalid" };
  const probe = (testMode = true) => spawnSync(process.execPath,
    ["--experimental-strip-types", join(release, "ops/postgres/check-runtime.mjs"),
      release, join(stage, "drevo.sqlite"), ...(testMode ? ["--test-migration-runtime"] : [])],
    { env: environment, encoding: "utf8", timeout: 30_000 });
  const unchanged = async () => {
    const row = await db.prepare("", "SELECT state,attempts FROM platform_ai_conversations WHERE id=?").get(ref);
    assert.equal(row?.state, "pending");
    assert.equal(Number(row?.attempts), 0, "preflight must never claim a provider DELETE");
  };
  try {
    const staged = spawnSync(python,
      [join(release, "ops/postgres/stage-ai-provider-key.py"),
        dirname(configuredPath), stage],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(staged.status, 0, staged.stderr);
    const keyPaths = providerCleanupKeyPaths(join(stage, "drevo.sqlite"));
    assert.deepEqual(readFileSync(keyPaths.primary), readFileSync(source.primary));
    assert.deepEqual(readFileSync(keyPaths.backup), readFileSync(source.backup));
    const productionGrammar = probe(false);
    assert.notEqual(productionGrammar.status, 0);
    assert.match(productionGrammar.stderr, /Expected an isolated preflight database/);
    await unchanged();
    for (const pass of [1, 2]) {
      const result = probe();
      assert.equal(result.status, 0, `runtime pass ${pass}: ${result.stderr}`);
      assert.match(result.stdout, /Provider HTTP calls during preflight: 0/, `runtime pass ${pass}`);
      await unchanged();
    }
    rmSync(keyPaths.primary);
    let result = probe();
    assert.notEqual(result.status, 0, "missing staged primary must fail closed");
    assert.match(result.stderr, /AI cleanup key is missing/);
    await unchanged();
    const wrong = Buffer.from(JSON.stringify({ version: 1,
      key: randomBytes(32).toString("base64") }));
    writeFileSync(keyPaths.primary, wrong, { mode: 0o600 });
    writeFileSync(keyPaths.backup, wrong);
    result = probe();
    assert.notEqual(result.status, 0, "wrong but matching pair must fail fingerprint check");
    assert.match(result.stderr, /does not match the database/);
    await unchanged();
    if (process.platform !== "win32") {
      writeFileSync(keyPaths.primary, readFileSync(source.primary));
      writeFileSync(keyPaths.backup, readFileSync(source.backup));
      chmodSync(keyPaths.primary, 0o644);
      result = probe();
      assert.notEqual(result.status, 0, "exposed key must fail closed");
      assert.match(result.stderr, /not a private regular file/);
      await unchanged();
    }
    console.log("PostgreSQL: deploy key pair and zero-provider preflight verified");
  } finally {
    await db.prepare("", "DELETE FROM platform_ai_conversations WHERE id=?").run(ref);
    rmSync(stage, { recursive: true, force: true });
  }
}
