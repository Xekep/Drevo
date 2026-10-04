import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { aiChatStore } from "../src/server/ai-chats.ts";
import { aiProviderCleanup, providerCleanupKeyPaths } from "../src/server/ai-provider-cleanup.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { storeDatabase } from "../src/server/store-database.ts";

test("two server processes publish one complete private key and backup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-provider-concurrent-"));
  const configured = join(directory, "platform.sqlite");
  try {
    const run = promisify(execFile);
    await Promise.all(["first", "second"].map((name) => run(process.execPath,
      ["--experimental-strip-types", "tests/fixtures/provider-cleanup-key-process.ts",
        join(directory, `${name}.sqlite`), configured],
      { cwd: process.cwd(), timeout: 15_000 })));
    const paths = providerCleanupKeyPaths(configured);
    assert.deepEqual(readFileSync(paths.primary), readFileSync(paths.backup));
    for (const name of ["first", "second"]) {
      const connection = new DatabaseSync(join(directory, `${name}.sqlite`));
      try {
        const row = connection.prepare("SELECT fingerprint FROM platform_ai_cleanup_keys").get();
        assert.match(String(row?.fingerprint), /^[a-f0-9]{64}$/);
      } finally { connection.close(); }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("known provider IDs retain original credentials through replacement, stale lease and deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-provider-cleanup-"));
  const path = join(directory, "source.sqlite");
  const source = new DatabaseSync(path);
  try {
    initializeArchiveSchema(source);
    const db = storeDatabase(source);
    const requests: Array<{ url: string; credential: string }> = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), credential: String((init?.headers as Record<string, string>)?.Authorization) });
      return new Response(null, { status: 204 });
    };
    const [first, second] = await Promise.all([
      aiProviderCleanup(db, path, fake as typeof fetch),
      aiProviderCleanup(db, path, fake as typeof fetch),
    ]);
    const paths = providerCleanupKeyPaths(path);
    assert.deepEqual(readFileSync(paths.primary), readFileSync(paths.backup));
    const chats = aiChatStore(db, first);
    const chat = await chats.create("owner", "all");
    const token = (await chats.acquire(chat.id))!;
    const initial = { baseUrl: "https://test.invalid/v1", folderId: "first-folder", apiKey: "first-secret" };
    assert.equal(await chats.bindNewRemote(chat.id, "first-provider-id", initial, token), true);
    const snapshot = await db.prepare(
      "SELECT encrypted_snapshot,state FROM platform_ai_conversations WHERE local_chat_id=?",
      "",
    ).get(chat.id);
    assert.equal(snapshot?.state, "active");
    assert.doesNotMatch(String(snapshot?.encrypted_snapshot), /first-provider-id|first-secret/);
    const replacement = { baseUrl: "https://test.invalid/v1", folderId: "second-folder", apiKey: "second-secret" };
    assert.equal(await chats.bindNewRemote(chat.id, "second-provider-id", replacement, token), true);
    assert.equal(await first.process(), 1, "replacement queues the old provider conversation");
    assert.deepEqual(requests, [{ url: "https://test.invalid/v1/conversations/first-provider-id",
      credential: "Api-Key first-secret" }]);
    await chats.release(chat.id, token);
    const oldToken = (await chats.acquire(chat.id))!;
    await db.prepare("UPDATE ai_chats SET busy_until=0 WHERE id=?", "").run(chat.id);
    const newToken = (await chats.acquire(chat.id))!;
    assert.notEqual(oldToken, newToken);
    assert.equal(await chats.bindNewRemote(chat.id, "stale-provider-id", initial, oldToken), false);
    assert.equal((await chats.read(chat.id, "owner"))?.yandexConversationId, "second-provider-id");
    assert.equal(await second.process(), 1, "a failed conditional bind compensates the known new ID");
    assert.equal(requests.at(-1)?.url, "https://test.invalid/v1/conversations/stale-provider-id");
    const expiredRef = await first.register(chat.id, "expired-provider-id", initial);
    await db.prepare("UPDATE platform_ai_conversations SET available_at=0 WHERE id=?", "").run(expiredRef);
    assert.equal((await second.claim(1))[0]?.id, expiredRef,
      "the worker can claim an expired provisional registration");
    assert.equal(await chats.bindRegisteredRemote(chat.id, "expired-provider-id", newToken, expiredRef), false,
      "a binder cannot resurrect a remote conversation after cleanup claimed it");
    assert.equal((await chats.read(chat.id, "owner"))?.yandexConversationId, "second-provider-id");
    await db.prepare("UPDATE platform_ai_conversations SET lease_until=0 WHERE id=?", "").run(expiredRef);
    assert.equal(await second.process(), 1);
    assert.equal(requests.at(-1)?.url, "https://test.invalid/v1/conversations/expired-provider-id");
    await db.prepare("UPDATE ai_chats SET busy_until=0 WHERE id=?", "").run(chat.id);
    assert.equal(await chats.bindNewRemote(chat.id, "lease-expired-provider-id", initial, newToken), false);
    assert.equal(await second.process(), 1,
      "an expired token cannot bind even if no successor acquired the chat yet");
    await chats.release(chat.id, newToken);
    await chats.delete(chat.id, "owner");
    assert.equal(await first.process(), 1);
    assert.equal(requests.at(-1)?.url, "https://test.invalid/v1/conversations/second-provider-id");
    assert.equal(requests.at(-1)?.credential, "Api-Key second-secret");
    assert.equal((await db.prepare(
      "SELECT encrypted_snapshot FROM platform_ai_conversations WHERE local_chat_id=? AND state='done' ORDER BY updated_at DESC LIMIT 1", "",
    ).get(chat.id))?.encrypted_snapshot, null,
    "terminal jobs retain no provider credential or ID ciphertext");

    writeFileSync(paths.primary, JSON.stringify({ version: 1, key: randomBytes(32).toString("base64") }));
    await assert.rejects(aiProviderCleanup(db, path, fake as typeof fetch), /does not match/);
    writeFileSync(paths.primary, readFileSync(paths.backup));
    rmSync(paths.primary);
    await assert.rejects(aiProviderCleanup(db, path, fake as typeof fetch), /missing/);
    writeFileSync(paths.primary, readFileSync(paths.backup), { mode: 0o600 });
    await aiProviderCleanup(db, path, fake as typeof fetch);
    rmSync(paths.backup);
    await assert.rejects(aiProviderCleanup(db, path, fake as typeof fetch), /ENOENT/);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid ciphertext blocks without retrying or contacting the provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-provider-invalid-"));
  const path = join(directory, "source.sqlite"), source = new DatabaseSync(path);
  try {
    initializeArchiveSchema(source);
    const db = storeDatabase(source);
    let calls = 0;
    const cleanup = await aiProviderCleanup(db, path, (async () => {
      calls++; return new Response(null, { status: 204 });
    }) as typeof fetch);
    const ref = await cleanup.register("local-chat", "remote-id", {
      baseUrl: "https://fake.invalid/v1", folderId: "folder", apiKey: "secret",
    });
    await cleanup.pending(ref);
    await db.prepare("UPDATE platform_ai_conversations SET encrypted_snapshot='broken' WHERE id=?", "").run(ref);
    assert.equal(await cleanup.process(), 1);
    const result = await db.prepare(
      "SELECT state,last_error FROM platform_ai_conversations WHERE id=?", "",
    ).get(ref);
    assert.equal(result?.state, "blocked");
    assert.equal(result?.last_error, "snapshot_invalid");
    assert.equal(calls, 0);
    assert.equal(await cleanup.process(), 0);
  } finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a known ID gets direct compensation when durable registration fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-provider-compensate-"));
  const path = join(directory, "source.sqlite"), source = new DatabaseSync(path);
  try {
    initializeArchiveSchema(source);
    const db = storeDatabase(source);
    const seen: string[] = [];
    const cleanup = await aiProviderCleanup(db, path, (async (url, init) => {
      seen.push(`${init?.method} ${String(url)}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    const chats = aiChatStore(db, cleanup);
    const chat = await chats.create("owner", "all"), token = (await chats.acquire(chat.id))!;
    const paths = providerCleanupKeyPaths(path);
    rmSync(paths.primary);
    await assert.rejects(chats.bindNewRemote(chat.id, "known-after-post", {
      baseUrl: "https://fake.invalid/v1", folderId: "folder", apiKey: "secret",
    }, token), /missing/);
    assert.deepEqual(seen, ["DELETE https://fake.invalid/v1/conversations/known-after-post"]);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM platform_ai_conversations", "").get())?.n, 0);
    assert.equal((await chats.read(chat.id, "owner"))?.yandexConversationId, null);
  } finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("transient failures back off, auth failures block, and 404 completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-provider-retry-"));
  const path = join(directory, "source.sqlite"), source = new DatabaseSync(path);
  try {
    initializeArchiveSchema(source);
    const db = storeDatabase(source);
    const statuses = [503, 401, 404];
    const cleanup = await aiProviderCleanup(db, path, (async () =>
      Response.json({ error: { message: "fake", code: "fake" } },
        { status: statuses.shift()! })) as typeof fetch);
    const ref = await cleanup.register("local-chat", "remote-id", {
      baseUrl: "https://fake.invalid/v1", folderId: "folder", apiKey: "secret",
    });
    await cleanup.pending(ref);
    assert.equal(await cleanup.process(), 1);
    const read = async () => await db.prepare(
      "SELECT state,available_at,attempts,last_error FROM platform_ai_conversations WHERE id=?", "",
    ).get(ref);
    assert.equal((await read())?.state, "pending");
    assert.equal((await read())?.last_error, "provider_http_503");
    assert.ok(Number((await read())?.available_at) > Date.now());
    assert.equal(await cleanup.process(), 0, "backoff prevents immediate retry");
    await db.prepare("UPDATE platform_ai_conversations SET available_at=0 WHERE id=?", "").run(ref);
    assert.equal(await cleanup.process(), 1);
    assert.equal((await read())?.state, "blocked");
    assert.equal((await read())?.last_error, "provider_auth_401");
    assert.equal(await cleanup.process(), 0, "blocked credentials require explicit operator action");
    await db.prepare("UPDATE platform_ai_conversations SET state='pending',available_at=0 WHERE id=?", "").run(ref);
    assert.equal(await cleanup.process(), 1);
    assert.equal((await read())?.state, "done");
    assert.equal(Number((await read())?.attempts), 3);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
