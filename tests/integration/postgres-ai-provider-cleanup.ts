import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiProviderCleanup, providerCleanupKeyPaths } from "../../src/server/ai-provider-cleanup.ts";
import { openPostgresDatabase, type StoreDatabase } from "../../src/server/store-database.ts";
import { verifyAiProviderAdminTest } from "./postgres-ai-provider-admin-test.ts";

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
  await verifyAiProviderCascadeQueue(db, configuredPath);
  await verifyAiProviderAdminTest(db, configuredPath);
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

/** Registered refs survive all SQL deletion routes; rollback keeps the chat active. */
export async function verifyAiProviderCascadeQueue(db: StoreDatabase, configuredPath: string) {
  const cleanup = await aiProviderCleanup(db, configuredPath, async () =>
    new Response(null, { status: 204 }));
  const chats = aiChatStore(db, cleanup);
  const runtime = { baseUrl: "https://fake-provider.invalid/v1", folderId: "cascade-folder",
    apiKey: "original-cascade-key" };
  const account = `cleanup-${randomUUID()}`;
  const archiveId = db.archiveId!;
  const refs: string[] = [];
  const createBound = async (userId: string) => {
    const chat = await chats.create(userId, "all");
    const token = (await chats.acquire(chat.id))!;
    assert.equal(await chats.bindNewRemote(chat.id, `remote-${chat.id}`, runtime, token), true);
    await chats.release(chat.id, token);
    const row = await db.prepare("", "SELECT provider_cleanup_ref FROM ai_chats WHERE id=?")
      .get(chat.id);
    const ref = String(row?.provider_cleanup_ref);
    refs.push(ref);
    return { id: chat.id, ref };
  };
  await db.prepare("", "INSERT INTO accounts(id,name,created_at) VALUES(?,?,'2026-01-01')")
    .run(account, "Cleanup fixture");
  await db.prepare("", `INSERT INTO archive_memberships
    (archive_id,user_id,role,approved,tree_access) VALUES(?,?,'reader',true,'all')`)
    .run(archiveId, account);
  try {
    const membershipChat = await createBound(account);
    const rollback = new Error("rollback deletion");
    await assert.rejects(db.transaction(async () => {
      await db.prepare("", "DELETE FROM archive_memberships WHERE archive_id=? AND user_id=?")
        .run(archiveId, account);
      assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
        .get(membershipChat.ref))?.state, "pending");
      throw rollback;
    }), (error) => error === rollback);
    assert.ok(await chats.read(membershipChat.id, account));
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(membershipChat.ref))?.state, "active", "rollback must not leave a queued delete");
    await db.prepare("", "DELETE FROM archive_memberships WHERE archive_id=? AND user_id=?")
      .run(archiveId, account);
    assert.equal(await chats.read(membershipChat.id, account), null);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(membershipChat.ref))?.state, "pending");

    await db.prepare("", `INSERT INTO archive_memberships
      (archive_id,user_id,role,approved,tree_access) VALUES(?,?,'reader',true,'all')`)
      .run(archiveId, account);
    const privilegedChat = await createBound(account);
    await db.transaction(async () => {
      await db.prepare("", "SELECT set_config('drevo.account_id',?,true)").get(account);
      await db.prepare("", "INSERT INTO deleted_account_tombstones(id,redact_comments) VALUES(?,false)")
        .run(account);
      await db.prepare("", "SELECT public.runtime_anonymize_deleted_account_history(?)")
        .get(account);
      assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
        .get(privilegedChat.ref))?.state, "pending",
      "security-definer account cleanup must queue the bound conversation");
      await db.prepare("", "DELETE FROM archive_memberships WHERE archive_id=? AND user_id=?")
        .run(archiveId, account);
      await db.prepare("", "DELETE FROM accounts WHERE id=?").run(account);
    });
    assert.equal(await chats.read(privilegedChat.id, account), null);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(privilegedChat.ref))?.state, "pending",
    "the cleanup obligation survives the committed account deletion");
  } finally {
    await db.prepare("", "DELETE FROM archive_memberships WHERE archive_id=? AND user_id=?")
      .run(archiveId, account);
    await db.prepare("", "DELETE FROM deleted_account_tombstones WHERE id=?").run(account);
    await db.prepare("", "DELETE FROM accounts WHERE id=?").run(account);
    for (const ref of refs)
      await db.prepare("", "DELETE FROM platform_ai_conversations WHERE id=?").run(ref);
  }

  const isolatedId = `cleanup-archive-${randomUUID()}`;
  const isolatedAccount = `cleanup-owner-${randomUUID()}`;
  await db.postgresTransaction!(async (client) => {
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [isolatedId]);
    await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
      VALUES($1,'Cleanup fixture','',false,0,1)`, [isolatedId]);
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Cleanup owner','2026-01-01')",
      [isolatedAccount]);
    await client.query(`INSERT INTO archive_memberships
      (archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'admin',true,'all')`,
      [isolatedId, isolatedAccount]);
  });
  const isolated = await openPostgresDatabase(isolatedId, db.file);
  let isolatedRef = "";
  try {
    const isolatedCleanup = await aiProviderCleanup(isolated, configuredPath);
    const isolatedChats = aiChatStore(isolated, isolatedCleanup);
    const chat = await isolatedChats.create(isolatedAccount, "all");
    const token = (await isolatedChats.acquire(chat.id))!;
    assert.equal(await isolatedChats.bindNewRemote(chat.id, "remote-isolated-archive",
      runtime, token), true);
    await isolatedChats.release(chat.id, token);
    isolatedRef = String((await isolated.prepare("", "SELECT provider_cleanup_ref FROM ai_chats WHERE id=?")
      .get(chat.id))?.provider_cleanup_ref);
    const archiveRollback = new Error("rollback archive deletion");
    await assert.rejects(isolated.postgresTransaction!(async (client) => {
      await client.query("DELETE FROM archives WHERE id=$1", [isolatedId]);
      assert.equal((await client.query("SELECT state FROM platform_ai_conversations WHERE id=$1",
        [isolatedRef])).rows[0]?.state, "pending");
      throw archiveRollback;
    }), (error) => error === archiveRollback);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(isolatedRef))?.state, "active", "archive rollback must preserve the active binding");
    assert.ok(await isolatedChats.read(chat.id, isolatedAccount));
    await isolated.postgresTransaction!(async (client) => {
      await client.query("DELETE FROM archives WHERE id=$1", [isolatedId]);
    });
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(isolatedRef))?.state, "pending", "FK archive cascade must queue the ref");
  } finally {
    await isolated.close();
    await db.postgresTransaction!(async (client) => {
      await client.query("DELETE FROM archives WHERE id=$1", [isolatedId]);
      await client.query("DELETE FROM accounts WHERE id=$1", [isolatedAccount]);
    });
    if (isolatedRef)
      await db.prepare("", "DELETE FROM platform_ai_conversations WHERE id=?").run(isolatedRef);
  }
  console.log("PostgreSQL: membership, privileged account, archive cascade and rollback queueing verified");
}
