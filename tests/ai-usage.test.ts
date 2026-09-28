import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { aiUsageStore } from "../src/server/ai-usage.ts";

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
