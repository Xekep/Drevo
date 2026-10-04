import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Client } from "pg";
import { adminMcpHttp } from "../../src/server/admin-mcp-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { mcpTokenStore } from "../../src/server/mcp-tokens.ts";
import { mcpUsageStore } from "../../src/server/mcp-usage.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

type Archive = Awaited<ReturnType<typeof openArchive>>;
type Phase = "beforeCommit" | "afterCommit";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

async function gatedAdminServer(archive: Archive, origin: string, phase: Phase) {
  const entered = deferred(), release = deferred();
  let first = true;
  let response: ServerResponse | undefined;
  const original = archive.db;
  const db: StoreDatabase = {
    ...original,
    transaction: async <T>(work: () => Promise<T>, readOnly?: boolean) => {
      if (!first) return original.transaction(work, readOnly);
      first = false;
      if (phase === "beforeCommit") {
        return original.transaction(async () => {
          const value = await work();
          entered.resolve();
          await release.promise;
          return value;
        }, readOnly);
      }
      const value = await original.transaction(work, readOnly);
      entered.resolve();
      await release.promise;
      return value;
    },
  };
  const handler = adminMcpHttp({ auth: await createAuth(await userStore(original), original, origin),
    db, tokens: mcpTokenStore(original), usage: mcpUsageStore(original), publicOrigin: origin });
  const server = createServer((req, res) => {
    response = res;
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.destroy(error); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    entered: entered.promise,
    release: release.resolve,
    get response() { return response; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function atGate(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("MCP mutation did not reach the commit gate")),
        15_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyMcpIssuanceVisibility(
  archive: Archive, client: Client, base: string, origin: string,
) {
  const tokens = mcpTokenStore(archive.db);
  const session = newSessionToken(), hash = sessionTokenHash(session);
  const suffix = randomUUID();
  const issueName = `MCP commit visibility ${suffix}`;
  const revokeName = `MCP revoke commit ${suffix}`;
  const deniedRevokeName = `MCP revoke delivery ${suffix}`;
  const deliveryName = `MCP delivery revoke ${suffix}`;
  const unrelatedName = `MCP unrelated credential ${suffix}`;
  const headers = { Cookie: `drevo_session=${session}`, Origin: origin,
    "Content-Type": "application/json" };
  const mcp = (token: string) => fetch(`${base}/mcp`, {
    method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}`,
      "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [hash, Date.now() + 600_000]);
  try {
    const gate = await gatedAdminServer(archive, origin, "beforeCommit");
    let issuedId: string | undefined;
    try {
      const issuing = fetch(`${gate.url}/api/mcp/tokens`, { method: "POST", headers,
        body: JSON.stringify({ name: issueName, scopes: ["tree:read"] }) });
      await atGate(gate.entered);
      assert.equal(gate.response?.headersSent, false,
        "201 must not reach the client before the new credential commits");
      assert.equal((await client.query("SELECT count(*)::int AS n FROM mcp_tokens WHERE name=$1",
        [issueName])).rows[0].n, 0, "another connection cannot read the uncommitted token");
      gate.release();
      const response = await issuing;
      assert.equal(response.status, 201);
      const credential = await response.json() as { token: string; item: { id: string } };
      issuedId = credential.item.id;
      assert.equal((await mcp(credential.token)).status, 200,
        "an immediate MCP request can authenticate after the 201 acknowledgment");
    } finally {
      gate.release();
      await gate.close();
      if (issuedId) await tokens.revoke(issuedId);
    }

    const revoked = await tokens.issue((await (await userStore(archive.db)).get("owner"))!,
      { name: revokeName, scopes: ["tree:read"] });
    const revokeGate = await gatedAdminServer(archive, origin, "beforeCommit");
    try {
      const revoking = fetch(`${revokeGate.url}/api/mcp/tokens/${revoked.item.id}`,
        { method: "DELETE", headers });
      await atGate(revokeGate.entered);
      assert.equal(revokeGate.response?.headersSent, false,
        "200 must not acknowledge a revoke before it commits");
      assert.equal((await client.query("SELECT revoked_at FROM mcp_tokens WHERE id=$1",
        [revoked.item.id])).rows[0].revoked_at, null);
      revokeGate.release();
      assert.equal((await revoking).status, 200);
      assert.equal((await mcp(revoked.token)).status, 401,
        "an immediate MCP request sees the committed revoke after its 200 acknowledgment");
    } finally {
      revokeGate.release();
      await revokeGate.close();
    }

    const deleteSession = newSessionToken(), deleteHash = sessionTokenHash(deleteSession);
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [deleteHash, Date.now() + 600_000]);
    const committedRevoke = await tokens.issue((await (await userStore(archive.db)).get("owner"))!,
      { name: deniedRevokeName, scopes: ["tree:read"] });
    const deniedRevokeGate = await gatedAdminServer(archive, origin, "afterCommit");
    try {
      const revoking = fetch(`${deniedRevokeGate.url}/api/mcp/tokens/${committedRevoke.item.id}`,
        { method: "DELETE", headers: { ...headers, Cookie: `drevo_session=${deleteSession}` } });
      await atGate(deniedRevokeGate.entered);
      assert.equal(deniedRevokeGate.response?.headersSent, false,
        "a committed revoke does not bypass the final session check before its acknowledgment");
      assert.ok((await client.query("SELECT revoked_at FROM mcp_tokens WHERE id=$1",
        [committedRevoke.item.id])).rows[0]?.revoked_at);
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [deleteHash]);
      deniedRevokeGate.release();
      assert.equal((await revoking).status, 403,
        "a completed session revoke blocks the DELETE acknowledgment after its write commits");
    } finally {
      deniedRevokeGate.release();
      await deniedRevokeGate.close();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [deleteHash]);
    }

    const revokedSession = newSessionToken(), revokedHash = sessionTokenHash(revokedSession);
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [revokedHash, Date.now() + 600_000]);
    const deliveryHeaders = { ...headers, Cookie: `drevo_session=${revokedSession}` };
    const unrelated = await tokens.issue((await (await userStore(archive.db)).get("owner"))!,
      { name: unrelatedName, scopes: ["tree:read"] });
    const deliveryGate = await gatedAdminServer(archive, origin, "afterCommit");
    try {
      const issuing = fetch(`${deliveryGate.url}/api/mcp/tokens`, { method: "POST",
        headers: deliveryHeaders,
        body: JSON.stringify({ name: deliveryName, scopes: ["tree:read"] }) });
      await atGate(deliveryGate.entered);
      assert.equal(deliveryGate.response?.headersSent, false,
        "a committed credential is not disclosed before the final access check");
      assert.equal((await client.query("SELECT count(*)::int AS n FROM mcp_tokens WHERE name=$1",
        [deliveryName])).rows[0].n, 1, "the write committed before the delivery gate");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
      deliveryGate.release();
      const denied = await issuing;
      assert.equal(denied.status, 403);
      assert.doesNotMatch(await denied.text(), /drevo_mcp_/,
        "a completed session revoke cannot receive the one-time token secret");
      const unused = await client.query("SELECT revoked_at FROM mcp_tokens WHERE name=$1",
        [deliveryName]);
      assert.ok(unused.rows[0]?.revoked_at,
        "a committed credential withheld at delivery is revoked by its exact new id");
      assert.equal((await client.query("SELECT revoked_at FROM mcp_tokens WHERE id=$1",
        [unrelated.item.id])).rows[0]?.revoked_at, null,
      "cleanup of a withheld secret must not revoke another credential");
    } finally {
      deliveryGate.release();
      await deliveryGate.close();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
    }
    console.log("runtime_mcp_issuance_visibility_ok");
  } finally {
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await client.query("DELETE FROM mcp_usage WHERE token_id IN (SELECT id FROM mcp_tokens WHERE name=ANY($1))",
      [[issueName, revokeName, deniedRevokeName, deliveryName, unrelatedName]]);
    await client.query("DELETE FROM mcp_tokens WHERE name=ANY($1)",
      [[issueName, revokeName, deniedRevokeName, deliveryName, unrelatedName]]);
  }
}
