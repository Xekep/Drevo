import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiProviderCleanup } from "../../src/server/ai-provider-cleanup.ts";
import { openPostgresDatabase, type StoreDatabase } from "../../src/server/store-database.ts";
import { backfillAiProviderActiveOrphans } from "../../ops/postgres/backfill-ai-provider-active-orphans.ts";

/** Only synthetic IDs and a fake provider are used in the disposable runtime DB. */
export async function verifyAiProviderActiveOrphanBackfill(db: StoreDatabase, keyPath: string) {
  const admin = new pg.Client({ user: process.env.PGADMINUSER,
    password: process.env.PGADMINPASSWORD });
  const blocker = new pg.Client({ user: process.env.PGADMINUSER,
    password: process.env.PGADMINPASSWORD });
  const runtime = new pg.Client();
  await admin.connect();
  await blocker.connect();
  await runtime.connect();
  const other = await openPostgresDatabase("other-archive", db.file);
  const calls: string[] = [];
  const fake = async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(null, { status: 204 });
  };
  const cleanup = await aiProviderCleanup(db, keyPath, fake as typeof fetch);
  const otherCleanup = await aiProviderCleanup(other, keyPath, fake as typeof fetch);
  const id = `orphan-${randomUUID()}`;
  const refs: string[] = [];
  const primaryChats = aiChatStore(db, cleanup);
  const otherChats = aiChatStore(other, otherCleanup);
  const credentials = { baseUrl: "https://fake-provider.invalid/v1",
    folderId: "original-folder", apiKey: "original-key" };
  const adminPid = (await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const waitForChatLock = async () => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const locks = await runtime.query<{ count: number }>(
        "SELECT cardinality(pg_blocking_pids($1)) AS count", [adminPid]);
      if (locks.rows[0].count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("AI cleanup backfill did not wait for the chat row lock");
  };
  const bound = async (store: StoreDatabase, chats: typeof primaryChats,
    provider: typeof cleanup, chatId: string, remote: string) => {
    const token = randomUUID();
    await store.prepare("", `INSERT INTO ai_chats(id,user_id,access_scope,busy_token,busy_until)
      VALUES(?,?,'all',?,?)`).run(chatId, "orphan-fixture", token, Date.now() + 60_000);
    const ref = await provider.register(chatId, remote, credentials);
    refs.push(ref);
    assert.equal(await chats.bindRegisteredRemote(chatId, remote, token, ref), true);
    return ref;
  };
  try {
    await assert.rejects(backfillAiProviderActiveOrphans(runtime), /bypasses RLS/);
    await admin.query("ALTER TABLE public.ai_chats DISABLE TRIGGER queue_deleted_ai_chat_conversation");
    try {
      await assert.rejects(backfillAiProviderActiveOrphans(admin), /enabled trigger 084/);
    } finally {
      await admin.query("ALTER TABLE public.ai_chats ENABLE TRIGGER queue_deleted_ai_chat_conversation");
    }
    const liveA = await bound(db, primaryChats, cleanup, id, "live-primary");
    const liveB = await bound(other, otherChats, otherCleanup, id, "live-other");
    const orphanId = `${id}-orphan`;
    const orphan = await bound(db, primaryChats, cleanup, orphanId, "historical-orphan");
    const mismatchId = `${id}-mismatch`;
    const mismatch = await bound(db, primaryChats, cleanup, mismatchId, "replaced-ref");
    const binding = await cleanup.register(`${id}-unbound`, "still-binding", credentials);
    refs.push(binding);

    // Reproduce a committed deletion while trigger 084 was not yet installed.
    await admin.query("BEGIN");
    try {
      await admin.query("ALTER TABLE public.ai_chats DISABLE TRIGGER queue_deleted_ai_chat_conversation");
      await admin.query("DELETE FROM public.ai_chats WHERE archive_id=$1 AND id=$2",
        [db.archiveId, orphanId]);
      await admin.query("ALTER TABLE public.ai_chats ENABLE TRIGGER queue_deleted_ai_chat_conversation");
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    await db.prepare("", "UPDATE ai_chats SET provider_cleanup_ref=? WHERE id=?")
      .run(randomUUID(), mismatchId);
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(orphan))?.state, "active");
    assert.deepEqual(await cleanup.claim(1), [], "active historical orphan is not a normal due job");

    // A rolled-back current deletion leaves both the chat and active ref intact.
    await admin.query("BEGIN");
    await admin.query("DELETE FROM public.ai_chats WHERE archive_id=$1 AND id=$2",
      [db.archiveId, id]);
    await admin.query("ROLLBACK");
    const first = await backfillAiProviderActiveOrphans(admin);
    assert.equal(first.queued, 2, "only absent/mismatched registered refs are recovered");
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(liveA))?.state, "active");
    assert.equal((await other.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(liveB))?.state, "active", "same chat ID in another archive stays live");
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(binding))?.state, "binding");
    for (const ref of [orphan, mismatch])
      assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
        .get(ref))?.state, "pending");
    assert.equal((await backfillAiProviderActiveOrphans(admin)).queued, 0,
      "recovery is idempotent");
    assert.equal(await cleanup.process(4), 2);
    assert.deepEqual(calls.sort(), [
      "https://fake-provider.invalid/v1/conversations/historical-orphan",
      "https://fake-provider.invalid/v1/conversations/replaced-ref",
    ]);
    for (const ref of [orphan, mismatch]) {
      const row = await db.prepare("", "SELECT state,encrypted_snapshot FROM platform_ai_conversations WHERE id=?")
        .get(ref);
      assert.equal(row?.state, "done");
      assert.equal(row?.encrypted_snapshot, null);
    }

    const deleteId = `${id}-delete-race`;
    const deleteRef = await bound(db, primaryChats, cleanup, deleteId, "delete-race");
    await blocker.query("BEGIN");
    await blocker.query("DELETE FROM public.ai_chats WHERE archive_id=$1 AND id=$2",
      [db.archiveId, deleteId]);
    const deleting = backfillAiProviderActiveOrphans(admin);
    await waitForChatLock();
    await blocker.query("COMMIT");
    assert.equal((await deleting).queued, 0, "084 trigger wins a concurrent deletion");
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(deleteRef))?.state, "pending");

    const bindId = `${id}-bind-race`;
    const oldRef = await bound(db, primaryChats, cleanup, bindId, "old-bind-race");
    const newRef = await cleanup.register(bindId, "new-bind-race", credentials);
    refs.push(newRef);
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM public.ai_chats WHERE archive_id=$1 AND id=$2 FOR UPDATE",
      [db.archiveId, bindId]);
    await blocker.query("UPDATE public.platform_ai_conversations SET state='active',available_at=0 WHERE id=$1 AND state='binding'",
      [newRef]);
    await blocker.query("UPDATE public.ai_chats SET provider_cleanup_ref=$1 WHERE archive_id=$2 AND id=$3",
      [newRef, db.archiveId, bindId]);
    await blocker.query("UPDATE public.platform_ai_conversations SET state='pending',available_at=0 WHERE id=$1 AND state='active'",
      [oldRef]);
    const bindingRun = backfillAiProviderActiveOrphans(admin);
    await waitForChatLock();
    await blocker.query("COMMIT");
    assert.equal((await bindingRun).queued, 0, "a concurrent bind queues only its old ref");
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(newRef))?.state, "active");
    assert.equal((await db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
      .get(oldRef))?.state, "pending");
    assert.equal(await cleanup.process(4), 2);
    assert.ok(calls.includes("https://fake-provider.invalid/v1/conversations/delete-race"));
    assert.ok(calls.includes("https://fake-provider.invalid/v1/conversations/old-bind-race"));
    console.log("PostgreSQL: privileged orphan recovery, cross-archive isolation and fake provider verified");
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await admin.query("DELETE FROM public.ai_chats WHERE archive_id=$1 AND id LIKE $2",
      [db.archiveId, `${id}%`]);
    await admin.query("DELETE FROM public.ai_chats WHERE archive_id='other-archive' AND id=$1", [id]);
    await admin.query("DELETE FROM public.platform_ai_conversations WHERE id=ANY($1::uuid[])", [refs]);
    await other.close();
    await runtime.end();
    await blocker.end();
    await admin.end();
  }
}
