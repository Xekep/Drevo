import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";

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


test("MCP token bound to a common-ancestors user sees only that projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-scope-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base =
    "http://127.0.0.1:" +
    (app.server.address() as { port: number }).port;

  try {
    const current = app.archive.read(),
      family: Family = {
        ...current.family,
        people: [
          ...current.family.people,
          {
            id: "mcp-parent",
            surname: "ВидимыйПредок",
            name: "Пётр",
            patronymic: "",
            sex: "m",
            birth: "1900",
            birthPlace: "",
            parents: [],
            spouses: [],
            generation: 1,
            column: 0,
            sources: [],
          },
          {
            id: "mcp-anchor",
            surname: "Якорь",
            name: "Иван",
            patronymic: "",
            sex: "m",
            birth: "1930",
            birthPlace: "",
            parents: ["mcp-parent"],
            spouses: [],
            generation: 2,
            column: 0,
            sources: [],
          },
          {
            id: "mcp-hidden",
            surname: "СкрытыйЧеловек",
            name: "Сергей",
            patronymic: "",
            sex: "m",
            birth: "1920",
            birthPlace: "",
            parents: [],
            spouses: [],
            generation: 1,
            column: 0,
            sources: [],
          },
        ],
      };
    app.archive.write(family, current.revision);

    app.archive.db
      .prepare(
        `INSERT INTO users(
          id,name,role,approved,person_id,tree_access
        ) VALUES('mcp-scoped-user','Ограниченный участник','reader',1,
                 'mcp-anchor','common_ancestors')`,
      )
      .run();

    const created = await fetch(base + "/api/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ограниченный MCP",
        scopes: ["tree:read"],
        rateLimitPerMinute: 20,
        boundUserId: "mcp-scoped-user",
      }),
    });
    assert.equal(created.status, 201);
    const issued = await created.json();
    assert.equal(issued.item.boundUser.id, "mcp-scoped-user");
    assert.equal(issued.item.boundUser.treeAccess, "common_ancestors");

    const headers = {
      Authorization: "Bearer " + issued.token,
      "Content-Type": "application/json",
    };
    const callSearch = async (query: string, id: number) =>
      fetch(base + "/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "search_people",
            arguments: { query },
          },
        }),
      }).then((response) => response.json());

    const visible = await callSearch("ВидимыйПредок", 101);
    assert.deepEqual(
      visible.result.structuredContent.people.map(
        (person: { id: string }) => person.id,
      ),
      ["mcp-parent"],
    );

    const hidden = await callSearch("СкрытыйЧеловек", 102);
    assert.deepEqual(hidden.result.structuredContent.people, []);

    const admin = await fetch(base + "/api/mcp/tokens").then((response) =>
      response.json(),
    );
    const listed = admin.tokens.find(
      (token: { id: string }) => token.id === issued.item.id,
    );
    assert.equal(listed.boundUser.id, "mcp-scoped-user");
    assert.ok(
      admin.bindings.some(
        (binding: { id: string; treeAccess: string }) =>
          binding.id === "mcp-scoped-user" &&
          binding.treeAccess === "common_ancestors",
      ),
    );

    app.archive.db
      .prepare("UPDATE users SET approved=0 WHERE id='mcp-scoped-user'")
      .run();

    const blocked = await fetch(base + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/list",
      }),
    });
    assert.equal(blocked.status, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("MCP rejects an explicit cross-origin browser request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-origin-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base =
    "http://127.0.0.1:" +
    (app.server.address() as { port: number }).port;
  try {
    const created = await fetch(base + "/api/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Origin test",
        scopes: ["tree:read"],
        rateLimitPerMinute: 10,
      }),
    });
    assert.equal(created.status, 201);
    const issued = await created.json();

    const blocked = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + issued.token,
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 201,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, "Invalid origin");

    const serverToServer = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + issued.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 202,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(serverToServer.status, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
