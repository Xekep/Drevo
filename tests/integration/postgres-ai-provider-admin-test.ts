import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { createAuth } from "../../src/server/auth.ts";
import { adminAiHttp } from "../../src/server/admin-ai-http.ts";
import { aiProviderCleanup } from "../../src/server/ai-provider-cleanup.ts";
import { aiSettingsStore } from "../../src/server/ai-settings.ts";
import { aiUsageStore } from "../../src/server/ai-usage.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

/** HTTP test with fake provider: live provisional lease, final queue, crash expiry. */
export async function verifyAiProviderAdminTest(db: StoreDatabase, configuredPath: string) {
  const tokenHash = `admin-test-${randomUUID()}`;
  await db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
    VALUES(?,'owner',?)`).run(tokenHash, Date.now() + 60_000);
  let authorized = true;
  let holdResponse = false;
  let failResponse = false;
  let entered!: () => void, release!: () => void;
  let responseEntered = new Promise<void>((resolve) => { entered = resolve; });
  let responseGate = new Promise<void>((resolve) => { release = resolve; });
  let nextId = 0;
  const seen: Array<{ url: string; authorization: string }> = [];
  const providerFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    seen.push({ url: path, authorization: new Headers(init?.headers).get("Authorization") || "" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/conversations")) return Response.json({ id: `admin-fixture-${++nextId}` });
    if (path.endsWith("/responses")) {
      if (holdResponse) { entered(); await responseGate; }
      if (failResponse)
        return Response.json({ error: { message: "provider remote admin-fixture-secret" } },
          { status: 503 });
      return Response.json({ id: "response-fixture", status: "completed", output_text: "OK" });
    }
    throw new Error("Unexpected fake provider request");
  }) as typeof fetch;
  const cleanup = await aiProviderCleanup(db, configuredPath, providerFetch);
  const fakeAuth = {
    isPlatformAdmin: async () => authorized,
    currentUser: async () => ({ id: "owner", approved: true }),
    accountProfile: async () => ({ id: "owner", name: "Owner" }),
    accountSession: async () => ({ accountId: "owner", tokenHash }),
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const storedSettings = await aiSettingsStore(db);
  const settings = {
    ...storedSettings,
    read: async () => ({ ...await storedSettings.read(), enabled: true,
      folderId: "fake-admin-folder", model: "gpt://fake-admin-folder/test" }),
    savedApiKey: async () => ({ value: "fake-admin-original-key", stored: true, error: "" }),
  };
  const handler = adminAiHttp({ auth: fakeAuth, db, settings,
    usage: aiUsageStore(db), providerCleanup: cleanup, fetcher: providerFetch });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.destroy(error); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    holdResponse = true;
    const request = fetch(base + "/api/admin/ai/test", { method: "POST" });
    await Promise.race([responseEntered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Admin test did not reach response")), 5000))]);
    const held = await db.prepare("", `SELECT id,state,available_at,encrypted_snapshot
      FROM platform_ai_conversations WHERE local_chat_id LIKE 'admin-test:%'
      ORDER BY created_at DESC LIMIT 1`).get();
    assert.equal(held?.state, "binding");
    assert.ok(Number(held.available_at) > Date.now() + 200_000,
      "worker must not delete while the bounded model check runs");
    assert.doesNotMatch(String(held.encrypted_snapshot), /fake-admin-original-key|admin-fixture/);
    assert.deepEqual(await cleanup.claim(1), [], "provisional admin test is not due");
    release();
    assert.equal((await request).status, 200);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(String(held.id)))?.state, "pending");
    assert.equal(await cleanup.process(1), 1);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(String(held.id)))?.state, "done");
    assert.ok(seen.some((call) => call.url.endsWith("/conversations/admin-fixture-1") &&
      call.authorization === "Api-Key fake-admin-original-key"));

    // Revocation after provider creation still queues the same credential.
    responseEntered = new Promise<void>((resolve) => { entered = resolve; });
    responseGate = new Promise<void>((resolve) => { release = resolve; });
    holdResponse = true;
    const revokedRequest = fetch(base + "/api/admin/ai/test", { method: "POST" });
    await responseEntered;
    const revokedBinding = await db.prepare("", `SELECT id,state,encrypted_snapshot
      FROM platform_ai_conversations WHERE local_chat_id LIKE 'admin-test:%'
        AND state='binding' ORDER BY created_at DESC,id DESC LIMIT 1`).get();
    assert.ok(revokedBinding);
    assert.equal(revokedBinding.state, "binding");
    assert.doesNotMatch(String(revokedBinding.encrypted_snapshot),
      /fake-admin-original-key|admin-fixture/);
    authorized = false;
    release();
    assert.equal((await revokedRequest).status, 403);
    // The 403 bytes can reach fetch before the handler's async finally queues
    // this already-durable binding. Wait for this exact conversation, not any
    // unrelated pending cleanup row.
    let revoked: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      revoked = await db.prepare("", "SELECT id,state FROM platform_ai_conversations WHERE id=?")
        .get(String(revokedBinding.id));
      if (revoked?.state === "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(revoked?.state, "pending");
    assert.equal(await cleanup.process(1), 1);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(String(revokedBinding.id)))?.state, "done");
    assert.ok(seen.some((call) => call.url.endsWith("/conversations/admin-fixture-2") &&
      call.authorization === "Api-Key fake-admin-original-key"));
    authorized = true;

    // A failed model request also queues cleanup, without returning provider IDs.
    const beforeFailure = new Set((await db.prepare("", `SELECT id FROM platform_ai_conversations
      WHERE local_chat_id LIKE 'admin-test:%'`).all()).map((row) => String(row.id)));
    holdResponse = false;
    failResponse = true;
    const failed = await fetch(base + "/api/admin/ai/test", { method: "POST" });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /admin-fixture-secret/);
    const newFailureRows = (await db.prepare("", `SELECT id,state FROM platform_ai_conversations
      WHERE local_chat_id LIKE 'admin-test:%'`).all())
      .filter((row) => !beforeFailure.has(String(row.id)));
    assert.equal(newFailureRows.length, 1);
    assert.equal(newFailureRows[0].state, "pending");
    assert.equal(await cleanup.process(1), 1);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(String(newFailureRows[0].id)))?.state, "done");
    assert.ok(seen.some((call) => call.url.endsWith("/conversations/admin-fixture-3") &&
      call.authorization === "Api-Key fake-admin-original-key"));

    // A process exit has no finally: expired provisional work is reclaimed.
    const crashRef = await cleanup.registerTest("admin-fixture-crash", {
      baseUrl: "https://fake-provider.invalid/v1", folderId: "fake-admin-folder",
      apiKey: "fake-admin-original-key" });
    assert.deepEqual(await cleanup.claim(1), []);
    await db.prepare("", "UPDATE platform_ai_conversations SET available_at=0 WHERE id=?")
      .run(crashRef);
    assert.equal(await cleanup.process(1), 1);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(crashRef))?.state, "done");
    console.log("PostgreSQL: admin test provisional lease, revoke and crash cleanup verified");
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.prepare("", "DELETE FROM platform_ai_conversations WHERE local_chat_id LIKE 'admin-test:%'").run();
    await db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?").run(tokenHash);
  }
}
