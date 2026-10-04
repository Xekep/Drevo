import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { aiCleanupStatusQuery } from "../src/server/ai-provider-cleanup-status.ts";
import { aiProviderCleanupHttp } from "../src/server/ai-provider-cleanup-http.ts";
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
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, "http://localhost")).catch(() =>
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
