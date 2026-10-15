import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { aiUsageStore, AiLimitError } from "../src/server/ai-usage.ts";

test("parallel turns reserve a shared token threshold, then release only confirmed unused tokens", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(raw);
    const db = storeDatabase(raw), usage = aiUsageStore(db);
    const limits = { requestsPerMinute: 0, dailyRequests: 0, dailyTokens: 100 };
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      aiUsageStore(db).admit(`user-${i}`, "model", limits)));
    const admitted = attempts.filter((value) => value.status === "fulfilled");
    assert.equal(admitted.length, 1);
    assert.equal((await usage.summary()).today.reservedTokens, 100);
    for (const attempt of attempts) if (attempt.status === "rejected") assert.ok(attempt.reason instanceof AiLimitError);
    const run = admitted[0].value;
    await usage.finish(run.id, run.started, { status: "ok", providerCalls: 1, inputTokens: 20, outputTokens: 10 });
    assert.equal((await usage.summary()).today.reservedTokens, 0);
    await usage.admit("another", "model", limits);
    assert.equal((await usage.summary()).today.reservedTokens, 70);
    await assert.rejects(aiUsageStore(db).admit("restart", "model", limits), AiLimitError);
    initializeArchiveSchema(raw);
    assert.equal((await usage.summary()).today.reservedTokens, 70, "schema startup cannot erase an in-flight/uncertain charge");
  } finally { raw.close(); }
});

test("personal reservations cross chats but not users; continuation does not consume another request", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(raw);
    const usage = aiUsageStore(storeDatabase(raw));
    const unlimited = { requestsPerMinute: 0, dailyRequests: 0, dailyTokens: 0 };
    const personal = { ...unlimited, requestsPerMinute: 1, dailyRequests: 1, dailyTokens: 100 };
    const first = await usage.admit("first", "model", unlimited, personal);
    const second = await usage.admit("second", "model", unlimited, personal);
    await usage.advance(first.id, "first", 20, 10, unlimited, personal);
    assert.equal((await usage.summary()).today.totalTokens, 30);
    assert.equal((await usage.summary()).today.reservedTokens, 170);
    await assert.rejects(usage.advance(first.id, "first", 70, 40, unlimited, personal), AiLimitError);
    await usage.finish(first.id, first.started, { status: "ok", providerCalls: 1, inputTokens: 70, outputTokens: 40 });
    await usage.advance(second.id, "second", 1, 1, unlimited, personal);
    await usage.finish(second.id, second.started, { status: "error", providerCalls: 0, inputTokens: 1, outputTokens: 1 });
    assert.equal((await usage.summary()).today.reservedTokens, 0, "cancellation before a paid call releases the unused window");
  } finally { raw.close(); }
});

test("uncertain provider charges retain the window until UTC rollover, independently of process lifetime", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(raw);
    const db = storeDatabase(raw), usage = aiUsageStore(db);
    const limits = { requestsPerMinute: 0, dailyRequests: 0, dailyTokens: 100 };
    const run = await usage.admit("user", "model", limits);
    await usage.finish(run.id, run.started, { status: "error", providerCalls: 1, inputTokens: 10, outputTokens: 20, uncertainTokens: 70 });
    assert.equal((await usage.summary()).today.reservedTokens, 70);
    await assert.rejects(aiUsageStore(db).admit("user", "model", limits), AiLimitError);
    await db.prepare("UPDATE ai_usage SET started_ms=0 WHERE id=?").run(run.id);
    await assert.rejects(usage.advance(run.id, "user", 10, 20, limits), /новые сутки/);
    const fresh = await usage.admit("user", "model", limits);
    assert.ok(fresh.id !== run.id);
    assert.equal((await usage.summary()).today.reservedTokens, 100);
  } finally { raw.close(); }
});

test("concurrent AI admission reserves the minute limit before the next turn", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(raw);
    const usage = aiUsageStore(storeDatabase(raw));
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        usage.admit("same-user", "model", {
          requestsPerMinute: 1,
          dailyRequests: 100,
          dailyTokens: 10000,
        }),
      ),
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    for (const attempt of attempts) {
      if (attempt.status !== "rejected") continue;
      assert.ok(attempt.reason instanceof AiLimitError);
      assert.ok((attempt.reason.retryAfterSeconds ?? 0) > 0);
    }
    assert.equal((await usage.summary()).today.requests, 1);
  } finally {
    raw.close();
  }
});

test("AI admission enforces both archive and user daily budgets and rolls back with input", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(raw);
    const db = storeDatabase(raw),
      usage = aiUsageStore(db);
    const limits = { requestsPerMinute: 0, dailyRequests: 2, dailyTokens: 0 };
    const personal = { ...limits, dailyRequests: 1 };
    await assert.rejects(
      db.transaction(async () => {
        await usage.admit("first", "model", limits, personal);
        throw new Error("input could not be saved");
      }),
      /input could not be saved/,
    );
    assert.equal((await usage.summary()).today.requests, 0);
    await usage.admit("first", "model", limits, personal);
    await assert.rejects(
      usage.admit("first", "model", limits, personal),
      /Ваш дневной лимит/,
    );
    await usage.admit("second", "model", limits, personal);
    await assert.rejects(
      usage.admit("third", "model", limits, personal),
      /Дневной лимит/,
    );
    assert.equal((await usage.summary()).today.requests, 2);
  } finally {
    raw.close();
  }
});

test("AI usage keeps input/output tokens split by actual model", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    const usage = aiUsageStore(storeDatabase(db)),
      run = await usage.begin("user-1", "gpt://folder/main-model/latest");

    await usage.finish(run.id, run.started, {
      status: "ok",
      providerCalls: 3,
      inputTokens: 180,
      outputTokens: 60,
      models: [
        {
          model: "gpt://folder/main-model/latest",
          providerCalls: 2,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
        },
        {
          model: "gpt://folder/vision-model/latest",
          providerCalls: 1,
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
        },
      ],
    });

    const summary = await usage.summary(),
      today = summary.today.models;
    assert.equal(summary.today.providerCalls, 3);
    assert.equal(summary.today.inputTokens, 180);
    assert.equal(summary.today.outputTokens, 60);
    assert.deepEqual(today, [
      {
        model: "gpt://folder/main-model/latest",
        providerCalls: 2,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        model: "gpt://folder/vision-model/latest",
        providerCalls: 1,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
      },
    ]);

    const current = summary.history.at(-1)!;
    assert.equal(current.inputTokens, 180);
    assert.equal(current.outputTokens, 60);
    assert.equal(current.totalTokens, 240);
    assert.deepEqual(current.models, today);
  } finally {
    db.close();
  }
});

test("schema v15 backfills old AI usage into its recorded model", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.exec("DROP TABLE ai_usage_models");
    db.prepare(
      `INSERT INTO ai_usage(
        at,started_ms,user_id,model,status,provider_calls,
        input_tokens,output_tokens,total_tokens,latency_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      new Date().toISOString(),
      Date.now(),
      "legacy-user",
      "legacy-model/latest",
      "ok",
      2,
      90,
      30,
      120,
      250,
    );
    db.exec("PRAGMA user_version=14");

    initializeArchiveSchema(db);

    assert.deepEqual(
      {
        ...db
          .prepare(
            `SELECT model,provider_calls,input_tokens,output_tokens,total_tokens
           FROM ai_usage_models`,
          )
          .get(),
      },
      {
        model: "legacy-model/latest",
        provider_calls: 2,
        input_tokens: 90,
        output_tokens: 30,
        total_tokens: 120,
      },
    );
  } finally {
    db.close();
  }
});
