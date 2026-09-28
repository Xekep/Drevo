import type { StoreDatabase } from "./store-database.ts";

export type AiUsageLimits = {
  requestsPerMinute: number;
  dailyRequests: number;
  dailyTokens: number;
};

export type AiModelUsage = {
  model: string;
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AiUsageSummary = {
  today: {
    requests: number;
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    errors: number;
    averageLatencyMs: number;
    models: AiModelUsage[];
  };
  history: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    models: AiModelUsage[];
  }>;
  recent: Array<{
    id: number;
    at: string;
    userId: string;
    model: string;
    status: "ok" | "error";
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    latencyMs: number;
  }>;
};

export class AiLimitError extends Error {
  retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function aiUsageStore(db: StoreDatabase) {
  const todayStart = () => {
    const now = new Date(),
      utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return utc;
  };

  return {
    async check(userId: string, limits: AiUsageLimits) {
      const now = Date.now(),
        minuteAgo = now - 60_000,
        recent = Number(
          (await db
            .prepare(
              "SELECT count(*) AS n FROM ai_usage WHERE user_id=? AND started_ms>=?",
              "SELECT count(*) AS n FROM ai_usage WHERE user_id=? AND started_ms>=?",
            )
            .get(userId, minuteAgo))!.n,
        );
      if (limits.requestsPerMinute > 0 && recent >= limits.requestsPerMinute) {
        const oldest = (await db
          .prepare(
            "SELECT min(started_ms) AS started FROM ai_usage WHERE user_id=? AND started_ms>=?",
            "SELECT min(started_ms) AS started FROM ai_usage WHERE user_id=? AND started_ms>=?",
          )
          .get(userId, minuteAgo))!.started as number | null;
        const retry = oldest
          ? Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000))
          : 60;
        throw new AiLimitError(
          "Слишком много запросов к ИИ. Повторите позже.",
          retry,
        );
      }

      const daily = (await db
        .prepare(
          `SELECT count(*) AS requests,coalesce(sum(total_tokens),0) AS tokens
           FROM ai_usage WHERE started_ms>=?`,
          "SELECT count(*) AS requests,coalesce(sum(total_tokens),0) AS tokens\n           FROM ai_usage WHERE started_ms>=?",
        )
        .get(todayStart()))!;
      if (
        limits.dailyRequests > 0 &&
        Number(daily.requests) >= limits.dailyRequests
      )
        throw new AiLimitError(
          "Дневной лимит запросов к ИИ исчерпан. Лимит обновится завтра.",
        );
      if (limits.dailyTokens > 0 && Number(daily.tokens) >= limits.dailyTokens)
        throw new AiLimitError(
          "Дневной лимит токенов ИИ исчерпан. Лимит обновится завтра.",
        );
    },

    async begin(userId: string, model: string) {
      const at = new Date().toISOString(),
        started = Date.now(),
        result = await db
          .prepare(
            `INSERT INTO ai_usage(
              at,started_ms,user_id,model,status,provider_calls,
              input_tokens,output_tokens,total_tokens,latency_ms
            ) VALUES(?,?,?,?,'error',0,0,0,0,0)`,
            "INSERT INTO ai_usage(\n              at,started_ms,user_id,model,status,provider_calls,\n              input_tokens,output_tokens,total_tokens,latency_ms\n            ) VALUES(?,?,?,?,'error',0,0,0,0,0) RETURNING id",
          )
          .run(at, started, userId, model);
      return {
        id: Number(result.lastInsertRowid),
        started,
      };
    },

    async finish(
      id: number,
      started: number,
      value: {
        status: "ok" | "error";
        providerCalls: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        models?: AiModelUsage[];
      },
    ) {
      const input = Math.max(0, Math.round(value.inputTokens)),
        output = Math.max(0, Math.round(value.outputTokens));
      const providerCalls = Math.max(0, Math.round(value.providerCalls));
      await db
        .prepare(
          `UPDATE ai_usage SET
          status=?,provider_calls=?,input_tokens=?,output_tokens=?,
          total_tokens=?,cached_input_tokens=?,latency_ms=?
         WHERE id=?`,
          "UPDATE ai_usage SET\n          status=?,provider_calls=?,input_tokens=?,output_tokens=?,\n          total_tokens=?,cached_input_tokens=?,latency_ms=?\n         WHERE id=?",
        )
        .run(
          value.status,
          providerCalls,
          input,
          output,
          input + output,
          Math.max(0, Math.round(value.cachedInputTokens || 0)),
          Math.max(0, Date.now() - started),
          id,
        );

      const fallbackModel = String(
          (
            await db
              .prepare(
                "SELECT model FROM ai_usage WHERE id=?",
                "SELECT model FROM ai_usage WHERE id=?",
              )
              .get(id)
          )?.model || "",
        ),
        models = value.models?.length
          ? value.models
          : fallbackModel
            ? [
                {
                  model: fallbackModel,
                  providerCalls,
                  inputTokens: input,
                  outputTokens: output,
                  totalTokens: input + output,
                },
              ]
            : [];
      await db
        .prepare(
          "DELETE FROM ai_usage_models WHERE usage_id=?",
          "DELETE FROM ai_usage_models WHERE usage_id=?",
        )
        .run(id);
      const insertModel = db.prepare(
        `INSERT INTO ai_usage_models(
          usage_id,model,provider_calls,input_tokens,output_tokens,total_tokens
        ) VALUES(?,?,?,?,?,?)`,
        "INSERT INTO ai_usage_models(\n          usage_id,model,provider_calls,input_tokens,output_tokens,total_tokens\n        ) VALUES(?,?,?,?,?,?)",
      );
      for (const model of models) {
        const modelInput = Math.max(0, Math.round(model.inputTokens)),
          modelOutput = Math.max(0, Math.round(model.outputTokens));
        await insertModel.run(
          id,
          model.model,
          Math.max(0, Math.round(model.providerCalls)),
          modelInput,
          modelOutput,
          modelInput + modelOutput,
        );
      }
    },

    async summary(limit = 20): Promise<AiUsageSummary> {
      const historyStart = todayStart() - 13 * 86_400_000,
        day = (await db
          .prepare(
            `SELECT
              count(*) AS requests,
              coalesce(sum(provider_calls),0) AS provider_calls,
              coalesce(sum(input_tokens),0) AS input_tokens,
              coalesce(sum(output_tokens),0) AS output_tokens,
              coalesce(sum(total_tokens),0) AS total_tokens,
              coalesce(sum(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,
              coalesce(avg(latency_ms),0) AS average_latency_ms
             FROM ai_usage WHERE started_ms>=?`,
            "SELECT\n              count(*) AS requests,\n              coalesce(sum(provider_calls),0) AS provider_calls,\n              coalesce(sum(input_tokens),0) AS input_tokens,\n              coalesce(sum(output_tokens),0) AS output_tokens,\n              coalesce(sum(total_tokens),0) AS total_tokens,\n              coalesce(sum(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,\n              coalesce(avg(latency_ms),0) AS average_latency_ms\n             FROM ai_usage WHERE started_ms>=?",
          )
          .get(todayStart()))!,
        modelRows = await db
          .prepare(
            `SELECT
               strftime('%Y-%m-%d', u.started_ms / 1000, 'unixepoch') AS day,
               m.model AS model,
               coalesce(sum(m.provider_calls),0) AS provider_calls,
               coalesce(sum(m.input_tokens),0) AS input_tokens,
               coalesce(sum(m.output_tokens),0) AS output_tokens,
               coalesce(sum(m.total_tokens),0) AS total_tokens
             FROM ai_usage_models m
             JOIN ai_usage u ON u.id=m.usage_id
             WHERE u.started_ms>=?
             GROUP BY day,m.model
             ORDER BY day,m.model`,
            "SELECT\n               to_char(to_timestamp(u.started_ms / 1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,\n               m.model AS model,\n               coalesce(sum(m.provider_calls),0) AS provider_calls,\n               coalesce(sum(m.input_tokens),0) AS input_tokens,\n               coalesce(sum(m.output_tokens),0) AS output_tokens,\n               coalesce(sum(m.total_tokens),0) AS total_tokens\n             FROM ai_usage_models m\n             JOIN ai_usage u ON u.id=m.usage_id\n             WHERE u.started_ms>=?\n             GROUP BY day,m.model\n             ORDER BY day,m.model",
          )
          .all(historyStart),
        todayModelRows = modelRows.filter(
          (row) =>
            String(row.day) ===
            new Date(todayStart()).toISOString().slice(0, 10),
        ),
        rows = await db
          .prepare(
            `SELECT id,at,user_id,model,status,provider_calls,input_tokens,
                    output_tokens,total_tokens,latency_ms
             FROM ai_usage ORDER BY id DESC LIMIT ?`,
            "SELECT id,at,user_id,model,status,provider_calls,input_tokens,\n                    output_tokens,total_tokens,latency_ms\n             FROM ai_usage ORDER BY id DESC LIMIT ?",
          )
          .all(Math.max(1, Math.min(100, limit)));
      return {
        today: {
          requests: Number(day.requests),
          providerCalls: Number(day.provider_calls),
          inputTokens: Number(day.input_tokens),
          outputTokens: Number(day.output_tokens),
          totalTokens: Number(day.total_tokens),
          errors: Number(day.errors),
          averageLatencyMs: Math.round(Number(day.average_latency_ms)),
          models: todayModelRows.map((row) => ({
            model: String(row.model),
            providerCalls: Number(row.provider_calls),
            inputTokens: Number(row.input_tokens),
            outputTokens: Number(row.output_tokens),
            totalTokens: Number(row.total_tokens),
          })),
        },
        history: Array.from({ length: 14 }, (_, index) => {
          const date = new Date(historyStart + index * 86_400_000),
            key = date.toISOString().slice(0, 10),
            models = modelRows
              .filter((row) => String(row.day) === key)
              .map((row) => ({
                model: String(row.model),
                providerCalls: Number(row.provider_calls),
                inputTokens: Number(row.input_tokens),
                outputTokens: Number(row.output_tokens),
                totalTokens: Number(row.total_tokens),
              })),
            inputTokens = models.reduce(
              (sum, model) => sum + model.inputTokens,
              0,
            ),
            outputTokens = models.reduce(
              (sum, model) => sum + model.outputTokens,
              0,
            );
          return {
            day: key,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            models,
          };
        }),
        recent: rows.map((row) => ({
          id: Number(row.id),
          at: String(row.at),
          userId: String(row.user_id),
          model: String(row.model),
          status: String(row.status) as "ok" | "error",
          providerCalls: Number(row.provider_calls),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          totalTokens: Number(row.total_tokens),
          latencyMs: Number(row.latency_ms),
        })),
      };
    },
  };
}
