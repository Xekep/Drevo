import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("removed external protocol rejects legacy credentials while built-in research remains available", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-removed-transport-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    // Emulate an older archive: removal neither drops the historical table nor
    // turns its retained hash into an HTTP authentication mechanism.
    const credential = "drevo_mcp_" + "fictional-fixture".repeat(3);
    await app.archive.db.exec(`CREATE TABLE mcp_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL
    ) STRICT`);
    await app.archive.db
      .prepare("INSERT INTO mcp_tokens VALUES(?,?,?)")
      .run(
        "legacy",
        createHash("sha256").update(credential).digest("hex"),
        "Fictional fixture",
      );
    const authorizations: Record<string, string>[] = [
      {},
      { Authorization: `Bearer ${credential}` },
    ];
    for (const headers of authorizations) {
      for (const [method, path] of [
        ["GET", "/mcp"],
        ["HEAD", "/mcp"],
        ["POST", "/mcp"],
        ["GET", "/api/mcp/tokens"],
        ["POST", "/api/mcp/tokens"],
        ["DELETE", "/api/mcp/tokens/legacy"],
      ]) {
        const response = await fetch(base + path, {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/list",
                }),
              }
            : {}),
        });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.doesNotMatch(
          await response.text(),
          /structuredContent|search_people|drevo_mcp_|token_hash/,
        );
      }
    }
    assert.equal(
      (await app.archive.db
        .prepare("SELECT count(*) AS n FROM mcp_tokens")
        .get())!.n,
      1,
      "the feature removal does not destructively rewrite existing archives",
    );
    for (const path of [
      "/api/family",
      "/api/admin/ai",
      "/api/ai/status",
      "/api/ai/chats",
      "/api/research/suggestions",
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      await response.arrayBuffer();
    }
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
