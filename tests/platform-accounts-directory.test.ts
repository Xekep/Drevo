import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type pg from "pg";
import { platformAccountsHttp } from "../src/server/platform-accounts-http.ts";

test("platform directory bounds pages, escapes search and guards delivery after session expiry", async () => {
  let authenticated = true, admin = true, expireBeforeDelivery = false;
  let expires = Date.now() + 60_000;
  const queries: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("SELECT a.id")) return { rows: Array.from({ length: 31 }, (_, index) => ({
      id: `id-${index}`, name: `Имя ${index}`, sort_name: `имя ${index}`, role: null,
      full_access: false, last_visit_at: null,
    })) };
    if (sql.includes("count(*)::int AS accounts")) return { rows: [{ accounts: 31, basic: 30, full: 1, admins: 1, researchers: 0 }] };
    if (sql.includes("FROM account_sessions")) return { rowCount: 1, rows: [{ expires_at: expires }] };
    if (sql.includes("FROM platform_admins")) return { rowCount: admin ? 1 : 0, rows: [] };
    return { rowCount: 1, rows: [{ id: "actor" }] };
  } } as unknown as pg.PoolClient;
  const db = { kind: "postgres", postgresTransaction: async <T>(work: (client: pg.PoolClient) => Promise<T>) => work(client)
  } as unknown as Parameters<typeof platformAccountsHttp>[0];
  const auth = { accountSession: async () => authenticated ? { accountId: "actor", tokenHash: "fixture" } : null
  } as unknown as Parameters<typeof platformAccountsHttp>[1];
  const handle = platformAccountsHttp(db, auth, async () => { if (expireBeforeDelivery) expires = Date.now() - 1; });
  const server = createServer((req, res) => void handle(req, res, new URL(req.url!, `http://${req.headers.host}`)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    authenticated = false;
    assert.equal((await fetch(base + "/api/platform/accounts")).status, 401);
    authenticated = true; admin = false;
    assert.equal((await fetch(base + "/api/platform/accounts/statistics")).status, 403);
    admin = true;
    const first = await fetch(base + "/api/platform/accounts?q=" + encodeURIComponent("ЁЖ%_"));
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.accounts.length, 30);
    assert.ok(body.next);
    const list = queries.find((query) => query.sql.includes("SELECT a.id"))!;
    assert.equal(list.values[1], "%еж\\%\\_%");
    assert.equal(list.values[4], 31);
    assert.equal(queries.some((query) => query.sql.includes("count(*)::int AS accounts")), false);
    assert.equal((await fetch(base + "/api/platform/accounts?after=" + body.next)).status, 200);
    assert.deepEqual(queries.filter((query) => query.sql.includes("SELECT a.id")).at(-1)!.values.slice(2, 4), ["имя 29", "id-29"]);
    assert.equal((await fetch(base + "/api/platform/accounts?after=bad")).status, 400);
    assert.equal((await fetch(base + "/api/platform/accounts/statistics")).status, 200);
    expireBeforeDelivery = true;
    const rejected = await fetch(base + "/api/platform/accounts");
    assert.equal(rejected.status, 403);
    assert.ok(!(await rejected.text()).includes("Имя 0"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
