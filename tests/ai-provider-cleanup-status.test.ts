import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { aiCleanupStatusQuery, canRetryBlockedCleanup } from "../src/server/ai-provider-cleanup-status.ts";

test("only worker-produced provider rejections can be manually queued", () => {
  for (const reason of ["provider_auth_401", "provider_auth_403",
    "provider_rejected_400", "provider_rejected_409", "provider_rejected_422"])
    assert.equal(canRetryBlockedCleanup("blocked", reason, true, true), true, reason);
  for (const reason of [null, "snapshot_invalid", "provider_network",
    "provider_auth_404", "provider_rejected_404", "provider_rejected_408",
    "provider_rejected_429", "provider_rejected_503", "provider_http_503",
    "private-provider-error-marker"])
    assert.equal(canRetryBlockedCleanup("blocked", reason, true, true), false, String(reason));
  assert.equal(canRetryBlockedCleanup("pending", "provider_auth_403", true, true), false);
  assert.equal(canRetryBlockedCleanup("blocked", "provider_auth_403", false, true), false);
  assert.equal(canRetryBlockedCleanup("blocked", "provider_auth_403", true, false), false);
});
import { aiProviderCleanupHttp } from "../src/server/ai-provider-cleanup-http.ts";
import { platformAiProviderCleanupHttp } from "../src/server/platform-ai-provider-cleanup-http.ts";
import { createAuth } from "../src/server/auth.ts";
import { userStore } from "../src/server/users.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../src/server/session-token.ts";

test("cleanup cursors reject another filter, unsafe bounds and malformed identifiers", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const id = "b13fa92a-8430-4c1b-b344-5e2abb73114e";
  const valid = encode({ at: 123, id, filter: "blocked" });
  assert.equal(
    aiCleanupStatusQuery(
      new URL(`https://archive.test/?filter=blocked&cursor=${valid}`),
    ).cursor?.id,
    id,
  );
  for (const query of [
    "filter=active",
    "cursor=%%",
    `cursor=${"a".repeat(181)}`,
    `cursor=${valid}`,
    `cursor=${encode({ at: -1, id, filter: "all" })}`,
    `cursor=${encode({ at: 1.5, id, filter: "all" })}`,
    `cursor=${encode({ at: 5, id: "not-a-uuid", filter: "all" })}`,
  ])
    assert.throws(() =>
      aiCleanupStatusQuery(new URL(`https://archive.test/?${query}`)),
    );
});

test("cleanup status honestly reports SQLite limits and rejects a revoked admin session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-ai-cleanup-status-"));
  const connection = new DatabaseSync(join(dir, "archive.sqlite"));
  initializeArchiveSchema(connection);
  const db = storeDatabase(connection);
  const users = await userStore(db);
  const admin = await users.register("admin", "Администратор");
  const auth = await createAuth(users, db, "https://archive.test");
  let revoke = false;
  const handle = aiProviderCleanupHttp({
    auth,
    db,
    beforeAccessLock: async () => {
      if (revoke)
        await db
          .prepare("DELETE FROM auth_sessions WHERE user_id=?", "")
          .run(admin.id);
    },
  });
  const platformHandle = platformAiProviderCleanupHttp({ auth, db,
    publicOrigin: "https://archive.test" });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    void (url.pathname.startsWith("/api/platform/")
      ? platformHandle(req, res, url) : handle(req, res, url)).catch(() =>
      res.destroy(),
    );
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const token = newSessionToken();
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        "",
      )
      .run(sessionTokenHash(token), admin.id, Date.now() + 60_000);
    const headers = { Cookie: `drevo_session=${token}` };
    assert.equal((await fetch(base + "/api/admin/ai/cleanup")).status, 401);
    const allowed = await fetch(base + "/api/admin/ai/cleanup", { headers });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    assert.equal((await allowed.json()).supported, false);
    const platform = await fetch(base + "/api/platform/ai/cleanup", { headers });
    assert.equal(platform.status, 501);
    assert.match((await platform.json()).error, /PostgreSQL/);
    assert.equal(
      (await fetch(base + "/api/admin/ai/cleanup", { headers, method: "POST" }))
        .status,
      405,
    );
    revoke = true;
    const revoked = await fetch(base + "/api/admin/ai/cleanup", { headers });
    assert.equal(revoked.status, 403);
    assert.equal("jobs" in (await revoked.json()), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
