import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server/index.ts";

test("runtime diagnostics require a current administrator and disclose no identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "drevo-runtime-metrics-"));
  const original = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(root, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const token = "a".repeat(64);
    await app.archive.db
      .prepare(
        "INSERT INTO users(id,name,role,approved) VALUES('admin','Private Test Name','admin',1)",
      )
      .run();
    await app.archive.db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
      .run(
        createHash("sha256").update(token).digest("hex"),
        "admin",
        Date.now() + 60_000,
      );
    assert.equal((await fetch(base + "/api/admin/runtime")).status, 403);
    const headers = { Cookie: `drevo_session=${token}` };
    const response = await fetch(base + "/api/admin/runtime", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.ok(!text.includes(token));
    assert.ok(!text.includes("Private Test Name"));
    const payload = JSON.parse(text);
    assert.ok(payload.process.memory.rss > 0);
    assert.ok(payload.requests.completed >= 1);
    await app.archive.db
      .prepare("UPDATE users SET role='reader' WHERE id='admin'")
      .run();
    assert.equal(
      (await fetch(base + "/api/admin/runtime", { headers })).status,
      403,
    );
  } finally {
    await app.close();
    if (original === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = original;
    await rm(root, { recursive: true, force: true });
  }
});
