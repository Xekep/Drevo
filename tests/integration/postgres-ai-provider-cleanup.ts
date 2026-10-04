import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiProviderCleanup, providerCleanupKeyPaths } from "../../src/server/ai-provider-cleanup.ts";
import { openPostgresDatabase, type StoreDatabase } from "../../src/server/store-database.ts";

/** Two independent pools exercise the platform queue without a real provider. */
export async function verifyAiProviderCleanup(db: StoreDatabase, configuredPath: string) {
  const other = await openPostgresDatabase(db.archiveId!, db.file);
  const paths = providerCleanupKeyPaths(configuredPath);
  const calls: string[] = [];
  let entered!: () => void, release!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fakeA = async (url: string | URL | Request) => {
    calls.push(String(url));
    entered();
    await held;
    return new Response(null, { status: 204 });
  };
  const fakeB = async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(null, { status: 404 });
  };
  const [first, second] = await Promise.all([
    aiProviderCleanup(db, configuredPath, fakeA as typeof fetch),
    aiProviderCleanup(other, configuredPath, fakeB as typeof fetch),
  ]);
  const key = readFileSync(paths.primary);
  assert.deepEqual(key, readFileSync(paths.backup), "both processes converge on the same backed-up key");
  const chats = aiChatStore(db, first);
  const chat = await chats.create("provider-cleanup-test", "all");
  try {
    const token = (await chats.acquire(chat.id))!;
    const runtime = { baseUrl: "https://fake-provider.invalid/v1", folderId: "original-folder",
      apiKey: "original-api-key" };
    assert.equal(await chats.bindNewRemote(chat.id, "known-remote-id", runtime, token), true);
    const row = await db.prepare("", `SELECT encrypted_snapshot,state FROM platform_ai_conversations
      WHERE local_chat_id=?`).get(chat.id);
    assert.equal(row?.state, "active");
    assert.doesNotMatch(String(row?.encrypted_snapshot), /known-remote-id|original-api-key/);
    await chats.release(chat.id, token);
    await chats.delete(chat.id, "provider-cleanup-test");
    const firstRun = first.process(1);
    await Promise.race([firstEntered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fake provider was not called")), 5000))]);
    assert.deepEqual(await second.claim(1), [], "another pool cannot claim a live lease");
    await db.prepare("", "UPDATE platform_ai_conversations SET lease_until=0 WHERE local_chat_id=?")
      .run(chat.id);
    assert.equal(await second.process(1), 1, "expired lease is reclaimed by another pool");
    release();
    assert.equal(await firstRun, 1);
    const state = await db.prepare("", "SELECT state,attempts FROM platform_ai_conversations WHERE local_chat_id=?")
      .get(chat.id);
    assert.equal(state?.state, "done", "a stale acknowledgement cannot overwrite the new claim");
    assert.equal(Number(state?.attempts), 2);
    assert.deepEqual(calls, [
      "https://fake-provider.invalid/v1/conversations/known-remote-id",
      "https://fake-provider.invalid/v1/conversations/known-remote-id",
    ]);

    renameSync(paths.primary, paths.primary + ".held");
    try { await assert.rejects(aiProviderCleanup(other, configuredPath, fakeB as typeof fetch), /missing/); }
    finally { renameSync(paths.primary + ".held", paths.primary); }
    writeFileSync(paths.primary, JSON.stringify({ version: 1, key: randomBytes(32).toString("base64") }));
    try { await assert.rejects(aiProviderCleanup(other, configuredPath, fakeB as typeof fetch), /does not match/); }
    finally { writeFileSync(paths.primary, key); }
    console.log("PostgreSQL: provider cleanup key pairing, two-pool leases and stale ack verified");
  } finally {
    release();
    await db.prepare("", "DELETE FROM platform_ai_conversations WHERE local_chat_id=?").run(chat.id);
    await db.prepare("", "DELETE FROM ai_chats WHERE id=?").run(chat.id);
    await other.close();
  }
}

export async function verifyAiProviderDeleteRoute(
  db: StoreDatabase, configuredPath: string, baseUrl: string,
  fetcher: typeof fetch, chatId: string, deleteCount: () => number,
) {
  const removed = await fetch(baseUrl + `/api/ai/chats/${chatId}`, { method: "DELETE" });
  assert.equal(removed.status, 200, await removed.clone().text());
  const queued = await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE local_chat_id=?")
    .get(chatId);
  assert.equal(queued?.state, "pending", "HTTP delete durably queues the original provider conversation");
  process.env.YANDEX_AI_API_KEY = "changed-after-creation";
  assert.equal(await (await aiProviderCleanup(db, configuredPath, fetcher)).process(), 1);
  assert.equal(deleteCount(), 1);
  assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE local_chat_id=?")
    .get(chatId))?.state, "done");
  await db.prepare("", "DELETE FROM platform_ai_conversations WHERE local_chat_id=?").run(chatId);
}
