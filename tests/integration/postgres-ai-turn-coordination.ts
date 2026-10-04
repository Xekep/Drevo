import assert from "node:assert/strict";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiUsageStore, AiLimitError } from "../../src/server/ai-usage.ts";
import {
  openPostgresDatabase,
  type StoreDatabase,
} from "../../src/server/store-database.ts";

/** Independent pools reproduce load-balancer routing without process-local state. */
export async function verifyAiTurnCoordination(db: StoreDatabase) {
  const second = await openPostgresDatabase(db.archiveId!, db.file);
  const otherTransaction = second.postgresTransaction;
  assert.ok(otherTransaction);
  const chats = aiChatStore(db),
    otherChats = aiChatStore(second);
  const chat = await chats.create("coordination-user", "all");
  try {
    const token = (await chats.acquire(chat.id))!;
    assert.ok(token);
    await otherChats.requestStop(chat.id, "another-user");
    assert.equal(await chats.turnStatus(chat.id, token), "active");
    await otherChats.requestStop(chat.id, "coordination-user");
    assert.equal(await chats.turnStatus(chat.id, token), "stopped");
    assert.equal(
      await otherChats.acquire(chat.id),
      null,
      "stop must keep the lease until the running turn exits",
    );
    await chats.release(chat.id, token);
    const nextToken = (await otherChats.acquire(chat.id))!;
    assert.ok(nextToken);
    assert.notEqual(nextToken, token);
    assert.equal(await otherChats.turnStatus(chat.id, nextToken), "active");
    assert.equal(await chats.turnStatus(chat.id, token), "lost");
    await chats.release(chat.id, token);
    assert.equal(
      await otherChats.isBusy(chat.id),
      true,
      "a late release must not clear a subsequent turn's lease",
    );
    await db.prepare("", "UPDATE ai_chats SET busy_until=? WHERE id=?").run(Date.now() - 1, chat.id);
    assert.equal(await otherChats.turnStatus(chat.id, nextToken), "lost",
      "an expired lease fences the old runner before it can save an answer");
    const replacement = (await chats.acquire(chat.id))!;
    assert.ok(replacement);
    await chats.setRemote(chat.id, "replacement-context", replacement);
    await otherChats.setRemote(chat.id, null, nextToken);
    assert.equal((await chats.read(chat.id, "coordination-user"))?.yandexConversationId,
      "replacement-context", "a stale runner cannot reset the replacement's context");
    await otherChats.release(chat.id, nextToken);
    assert.equal(await chats.turnStatus(chat.id, replacement), "active");
    await assert.rejects(chats.turnStatus(chat.id, replacement, true), /транзакции/);
    await db.transaction(async () => {
      assert.equal(await chats.turnStatus(chat.id, replacement, true), "active");
      await assert.rejects(otherTransaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='100ms'");
        // A takeover after the TTL cannot pass the final commit's row lock.
        // A future cutoff avoids waiting a minute in this database test.
        await client.query(`UPDATE ai_chats SET busy_token='conflicting-runner'
          WHERE id=$1 AND busy_until<$2`, [chat.id, Date.now() + 120_000]);
      }), (error: unknown) => (error as { code?: string }).code === "55P03");
    });
    assert.equal(await chats.turnStatus(chat.id, replacement), "active");
    await chats.release(chat.id, replacement);

    const stores = [aiUsageStore(db), aiUsageStore(second)];
    const attempts = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        stores[index % 2].admit("coordination-user", "test-model", {
          requestsPerMinute: 1,
          dailyRequests: 100,
          dailyTokens: 0,
        }),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
      "two pools cannot admit more than the configured minute limit",
    );
    for (const result of attempts)
      if (result.status === "rejected")
        assert.ok(result.reason instanceof AiLimitError);
    const baseline = (await stores[0].summary()).today.requests;
    const dailyAttempts = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        stores[index % 2].admit(`coordination-daily-${index}`, "coordination-daily", {
          requestsPerMinute: 0,
          dailyRequests: baseline + 2,
          dailyTokens: 0,
        })),
    );
    assert.equal(dailyAttempts.filter((result) => result.status === "fulfilled").length, 2,
      "different users share the archive daily budget across pools");
    for (const result of dailyAttempts)
      if (result.status === "rejected") assert.ok(result.reason instanceof AiLimitError);
    console.log(
      "PostgreSQL: cross-backend AI stop and atomic admission verified",
    );
  } finally {
    await chats.delete(chat.id, "coordination-user");
    await db
      .prepare("", "DELETE FROM ai_usage WHERE user_id=?")
      .run("coordination-user");
    await db.prepare("", "DELETE FROM ai_usage WHERE model=?").run("coordination-daily");
    await second.close();
  }
}
