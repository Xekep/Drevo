import assert from "node:assert/strict";
import type { Client } from "pg";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { aiUsageStore, AiLimitError } from "../../src/server/ai-usage.ts";

export async function verifyAiTokenBudget(first: StoreDatabase, second: StoreDatabase, client: Client) {
  const stores = [aiUsageStore(first), aiUsageStore(second)];
  const unlimited = { requestsPerMinute: 0, dailyRequests: 0, dailyTokens: 0 };
  const personal = { ...unlimited, dailyTokens: 100 };
  const prefix = "token-budget-audit-";
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      stores[i % 2].admit(prefix + "shared", "model", unlimited, personal)));
    const admitted = attempts.filter((attempt) => attempt.status === "fulfilled");
    assert.equal(admitted.length, 1, "one account has one shared token threshold across archives and connections");
    for (const attempt of attempts) if (attempt.status === "rejected") assert.ok(attempt.reason instanceof AiLimitError);
    const run = admitted[0].value;
    await stores[1].advance(run.id, prefix + "shared", 20, 10, unlimited, personal);
    await stores[1].finish(run.id, run.started, { status: "ok", providerCalls: 1, inputTokens: 20, outputTokens: 10 });
    const next = await stores[0].admit(prefix + "shared", "model", unlimited, personal);
    assert.equal(Number((await client.query("SELECT reserved_tokens FROM platform_ai_usage WHERE id=$1", [next.id])).rows[0].reserved_tokens), 70);
    await stores[0].finish(next.id, next.started, { status: "error", providerCalls: 1, inputTokens: 0, outputTokens: 0, uncertainTokens: 70 });
    await assert.rejects(aiUsageStore(second).admit(prefix + "shared", "model", unlimited, personal), AiLimitError,
      "a recreated store cannot forget the unknown charge of another process");
    const independent = await stores[1].admit(prefix + "independent", "model", unlimited, personal);
    await stores[1].finish(independent.id, independent.started, { status: "error", providerCalls: 0, inputTokens: 0, outputTokens: 0 });
    await client.query("DELETE FROM platform_ai_usage WHERE user_id LIKE $1", [prefix + "%"]);

    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const baseline = Number((await client.query("SELECT coalesce(sum(total_tokens+reserved_tokens+uncertain_tokens),0) AS n FROM platform_ai_usage WHERE started_ms >= $1", [start.getTime()])).rows[0].n);
    const global = { ...unlimited, dailyTokens: baseline + 100 };
    const globalAttempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      stores[i % 2].admit(prefix + i, "model", global)));
    assert.equal(globalAttempts.filter((attempt) => attempt.status === "fulfilled").length, 1,
      "the platform reservation is atomic even when accounts and archives differ");
    assert.equal((await second.prepare("", "SELECT 1 AS value").get())?.value, 1,
      "an admitted turn retains no database connection or transaction");
  } finally {
    await client.query("DELETE FROM platform_ai_usage WHERE user_id LIKE $1", [prefix + "%"]);
  }
  console.log("ai_token_reservations_cross_archive_verified");
}
