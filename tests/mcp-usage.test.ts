import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import { mcpTokenStore } from "../src/server/mcp-tokens.ts";
import { mcpUsageStore, McpRateLimitError } from "../src/server/mcp-usage.ts";

test("parallel MCP reservations share the same minute budget", async () => {
  const raw = new DatabaseSync(":memory:");
  initializeArchiveSchema(raw);
  const db = storeDatabase(raw);
  try {
    const issued = await mcpTokenStore(db).issue(
      {
        id: "local",
        name: "Тест",
        role: "admin",
        approved: true,
        createdAt: "",
      },
      { name: "Лимит", scopes: ["tree:read"], rateLimitPerMinute: 5 },
    );
    const stores = [mcpUsageStore(db), mcpUsageStore(db)];
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        stores[index % 2].begin(issued.item.id, "tools/list", undefined, 5),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      5,
    );
    for (const result of results)
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof McpRateLimitError);
      assert.ok((result.reason.retryAfterSeconds ?? 0) > 0);
      }
    assert.equal((await stores[0].tokenSummary(issued.item.id)).callsToday, 5);
    await db
      .prepare("UPDATE mcp_usage SET started_ms=?")
      .run(Date.now() - 61_000);
    await stores[1].begin(issued.item.id, "tools/list", undefined, 5);
    assert.equal((await stores[0].tokenSummary(issued.item.id)).callsToday, 6);
  } finally {
    await db.close();
  }
});
