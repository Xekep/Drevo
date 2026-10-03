import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type ClientRequest } from "node:http";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";

test("MCP audit failure is logged and shutdown waits for the audit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-audit-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const prepare = app.archive.db.prepare;
  const log = console.error;
  const errors: unknown[][] = [];
  let release!: () => void, began!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  try {
    const issued = await fetch(base + "/api/mcp/tokens", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Журнал", scopes: ["tree:read"] }),
    }).then(response => response.json());
    console.error = (...args: unknown[]) => { errors.push(args); };
    app.archive.db.prepare = (sql, postgresSql) => {
      const statement = prepare(sql, postgresSql);
      if (!sql.startsWith("UPDATE mcp_usage")) return statement;
      return { ...statement, run: async () => {
        began(); await waiting; throw new Error("Test storage unavailable");
      } };
    };
    const response = await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    await response.json(); await started;
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    release(); await closing;
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /журнала MCP/);
  } finally {
    release(); console.error = log; app.archive.db.prepare = prepare;
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking an MCP token while its request body arrives prevents tool output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-midrequest-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let pendingRequest: ClientRequest | undefined;
  try {
    const issuedResponse = await fetch(base + "/api/mcp/tokens", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Отзыв во время запроса", scopes: ["tree:read"] }),
    });
    assert.equal(issuedResponse.status, 201);
    const issued = await issuedResponse.json();
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: "search_people", arguments: { query: "Иван" } } }));
    const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      pendingRequest = httpRequest(base + "/mcp", { method: "POST", headers: {
        Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json",
        "Content-Length": payload.length,
      } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      pendingRequest.on("error", reject);
      pendingRequest.write(payload.subarray(0,20));
    });
    let firstAuthenticationFinished = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await app.archive.db.prepare(
        "SELECT last_used_at FROM mcp_tokens WHERE id=?",
      ).get(issued.item.id);
      if (row?.last_used_at) { firstAuthenticationFinished = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(firstAuthenticationFinished, true);
    await app.archive.db.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE id=?")
      .run(new Date().toISOString(), issued.item.id);
    pendingRequest!.end(payload.subarray(20));
    const result = await responsePromise;
    assert.equal(result.status, 401);
    assert.doesNotMatch(result.body, /structuredContent|people/);
  } finally {
    pendingRequest?.destroy();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin-issued MCP token exposes only granted read-only tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base =
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
  try {
    const created = await fetch(base + "/api/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Тест",
        scopes: ["tree:read"],
        expiresDays: 30,
        rateLimitPerMinute: 5,
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
    assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
    assert.equal(discover.result.resultType, "complete");
    assert.equal(discover.result.ttlMs, 0);
    assert.equal(discover.result.cacheScope, "private");
    assert.equal(
      discover.result._meta["io.modelcontextprotocol/serverInfo"].name,
      "drevo",
    );

    const modernListed = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        ...headers,
        "MCP-Protocol-Version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }).then((response) => response.json());
    assert.equal(modernListed.result.resultType, "complete");
    assert.equal(modernListed.result.ttlMs, 0);
    assert.equal(modernListed.result.cacheScope, "private");
    assert.equal(
      modernListed.result._meta["io.modelcontextprotocol/serverInfo"].name,
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
    const names = listed.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    assert.ok(names.includes("search_people"));
    assert.ok(names.includes("query_people"));
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
    assert.equal(audit.tokens[0].rateLimitPerMinute, 5);
    assert.equal(audit.tokens[0].usage.callsToday, 5);
    assert.equal(audit.tokens[0].usage.errorsToday, 1);
    assert.ok(
      audit.recentUsage.some(
        (item: { toolName?: string; status: string }) =>
          item.toolName === "find_inconsistencies" && item.status === "error",
      ),
    );
    assert.equal(
      JSON.stringify(audit.recentUsage).includes("arguments"),
      false,
    );

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
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;

  try {
    const current = await app.archive.read(),
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
    await app.archive.write(family, current.revision);

    await app.archive.db
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

    const query = async (criteria: Record<string, unknown>) => fetch(base + "/mcp", {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 104, method: "tools/call",
        params: { name: "query_people", arguments: { criteria, limit: 0 } } }),
    }).then((response) => response.json());
    const scopedCount = await query({ birthYearTo: 1940 });
    assert.equal(scopedCount.result.structuredContent.total, 2);
    assert.equal(scopedCount.result.structuredContent.totalPeople, 2);
    assert.deepEqual(scopedCount.result.structuredContent.people, []);
    const hiddenCount = await query({ surname: "СкрытыйЧеловек" });
    assert.equal(hiddenCount.result.structuredContent.total, 0);
    const hiddenAnchor = await query({ relativeOf: "mcp-hidden", relation: "children" });
    assert.equal(hiddenAnchor.result.isError, true);
    assert.match(hiddenAnchor.result.content[0].text, /не найден в доступном архиве/);

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

    await app.archive.db
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
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
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
