import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("admin-issued MCP token exposes only granted read-only tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base =
    "http://127.0.0.1:" +
    (app.server.address() as { port: number }).port;
  try {
    const created = await fetch(base + "/api/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Тест",
        scopes: ["tree:read"],
        expiresDays: 30,
        rateLimitPerMinute: 4,
      }),
    });
    assert.equal(created.status, 201);
    const issued = await created.json();
    assert.match(issued.token, /^drevo_mcp_/);
    assert.notEqual(issued.item.tokenHint, issued.token);

    const headers = {
      Authorization: "Bearer " + issued.token,
      "Content-Type": "application/json",
    };
    const initialize = await fetch(base + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
    });
    assert.equal(initialize.status, 200);
    assert.equal((await initialize.json()).result.serverInfo.name, "drevo");

    const discover = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        ...headers,
        "MCP-Protocol-Version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
        },
      }),
    }).then((response) => response.json());
    assert.ok(discover.result.supportedVersions.includes("2026-07-28"));
    assert.equal(
      discover.result._meta["io.modelcontextprotocol/serverInfo"].name,
      "drevo",
    );

    const listed = await fetch(base + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }).then((response) => response.json());
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes("search_people"));
    assert.ok(names.includes("get_ancestors"));
    assert.equal(names.includes("find_inconsistencies"), false);
    assert.equal(names.includes("get_sources"), false);

    const denied = await fetch(base + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find_inconsistencies", arguments: {} },
      }),
    }).then((response) => response.json());
    assert.equal(denied.result.isError, true);

    const audit = await fetch(base + "/api/mcp/tokens").then((response) =>
      response.json(),
    );
    assert.equal(audit.tokens[0].rateLimitPerMinute, 4);
    assert.equal(audit.tokens[0].usage.callsToday, 4);
    assert.equal(audit.tokens[0].usage.errorsToday, 1);
    assert.ok(
      audit.recentUsage.some(
        (item: { toolName?: string; status: string }) =>
          item.toolName === "find_inconsistencies" && item.status === "error",
      ),
    );
    assert.equal(JSON.stringify(audit.recentUsage).includes("arguments"), false);

    const limited = await fetch(base + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 31,
        method: "ping",
      }),
    });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error.message, /Слишком много MCP/);

    const missingAuth = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
      }),
    });
    assert.equal(missingAuth.status, 401);

    const revoked = await fetch(
      base + "/api/mcp/tokens/" + encodeURIComponent(issued.item.id),
      { method: "DELETE" },
    );
    assert.equal(revoked.status, 200);

    const afterRevoke = await fetch(base + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
      }),
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
