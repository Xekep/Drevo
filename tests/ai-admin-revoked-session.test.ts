import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { adminAiHttp } from "../src/server/admin-ai-http.ts";
import { aiSettingsStore } from "../src/server/ai-settings.ts";
import { aiUsageStore } from "../src/server/ai-usage.ts";
import { createAuth } from "../src/server/auth.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../src/server/session-token.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import { userStore } from "../src/server/users.ts";

test("AI settings reject a session revoked between the platform grant and actor read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-ai-admin-revocation-"));
  const connection = new DatabaseSync(join(directory, "archive.sqlite"));
  initializeArchiveSchema(connection);
  const db = storeDatabase(connection);
  const users = await userStore(db);
  const admin = await users.register("platform-admin", "Администратор");
  const auth = await createAuth(users, db, "https://archive.test");
  const permitted = auth.isPlatformAdmin;
  let revoked = 0;
  auth.isPlatformAdmin = async (req) => {
    const allowed = await permitted(req);
    if (allowed) {
      // Reproduce a concurrent logout after the first successful grant check.
      await db
        .prepare("DELETE FROM auth_sessions WHERE user_id=?", "")
        .run(admin.id);
      revoked++;
    }
    return allowed;
  };
  const settings = await aiSettingsStore(db);
  let settingsReads = 0;
  let providerCalls = 0;
  const handle = adminAiHttp({
    auth,
    db,
    publicOrigin: "https://archive.test",
    usage: aiUsageStore(db),
    settings: {
      ...settings,
      async read() {
        settingsReads++;
        return settings.read();
      },
    },
    fetcher: async () => {
      providerCalls++;
      throw new Error("A revoked session must not reach the provider");
    },
  });
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, "http://localhost")).catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unexpected handler failure" }));
    });
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const [method, path] of [
      ["GET", "/api/admin/ai"],
      ["PUT", "/api/admin/ai"],
      ["POST", "/api/admin/ai/models"],
      ["POST", "/api/admin/ai/test"],
    ]) {
      const token = newSessionToken();
      await db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
          "",
        )
        .run(sessionTokenHash(token), admin.id, Date.now() + 60_000);
      const response = await fetch(base + path, {
        method,
        headers: {
          Cookie: `drevo_session=${token}`,
          Origin: "https://archive.test",
        },
      });
      assert.equal(
        response.status,
        401,
        `${method} ${path} must reject the finished session`,
      );
      assert.match((await response.json()).error, /сеанс/i);
    }
    assert.equal(
      revoked,
      4,
      "every route starts with a real valid administrator session",
    );
    assert.equal(settingsReads, 0);
    assert.equal(providerCalls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
