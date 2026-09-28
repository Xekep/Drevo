import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { mcpTokenStore } from "../src/server/mcp-tokens.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const admin: ArchiveUser = {
  id: "admin",
  name: "Администратор",
  role: "admin",
  createdAt: "",
  approved: true,
};

test("MCP tokens are shown once, hashed at rest and revocable", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const store = mcpTokenStore(storeDatabase(db)),
      issued = await store.issue(admin, {
        name: "AI Studio",
        scopes: ["tree:read", "analysis:read"],
        expiresDays: 30,
        rateLimitPerMinute: 25,
      });

    assert.match(issued.token, /^drevo_mcp_/);
    assert.equal((await store.list())[0].name, "AI Studio");
    assert.equal(
      JSON.stringify(await store.list()).includes(issued.token),
      false,
    );
    assert.notEqual(
      String(db.prepare("SELECT token_hash FROM mcp_tokens").get()!.token_hash),
      issued.token,
    );

    const grant = await store.authenticate("Bearer " + issued.token);
    assert.deepEqual(grant?.scopes, ["tree:read", "analysis:read"]);
    assert.equal(grant?.rateLimitPerMinute, 25);
    assert.equal((await store.list())[0].rateLimitPerMinute, 25);
    assert.equal((await store.list())[0].boundUser, undefined);

    await store.revoke(issued.item.id);
    assert.equal(await store.authenticate("Bearer " + issued.token), null);
    assert.ok((await store.list())[0].revokedAt);
  } finally {
    db.close();
  }
});
