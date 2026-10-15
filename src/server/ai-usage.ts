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
    reservedTokens?: number;
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
  // Scheduling window, not an estimate of provider billing. The last paid
  // call can exceed this soft threshold; do not present it as a hard cap.
  const reservationWindow = 32_000;
  const lockBudget = async () => {
    if (db.kind === "postgres")
      await db.prepare("", "SELECT pg_advisory_xact_lock(186743300)").get();
  };
  const reserve = async (id: number, remaining: Array<number | null>) => {
    const finite = remaining.filter((value): value is number => value !== null);
    if (!finite.length) return 0;
    const tokens = Math.min(reservationWindow, ...finite);
    await db.prepare("UPDATE ai_usage SET reserved_tokens=? WHERE id=?",
      "UPDATE platform_ai_usage SET reserved_tokens=? WHERE id=?").run(tokens, id);
    return tokens;
  };
  const todayStart = () => {
    const now = new Date(),
      utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return utc;
  };

  const store = {
    async check(
      userId: string,
      limits: AiUsageLimits,
      dailyScope: "archive" | "user" = "archive",
      tokensOnly = false,
    ) {
      if (tokensOnly ? limits.dailyTokens <= 0 :
        limits.requestsPerMinute <= 0 && limits.dailyRequests <= 0 && limits.dailyTokens <= 0)
        return null;
      const now = Date.now(),
        minuteAgo = now - 60_000,
        recent = tokensOnly || limits.requestsPerMinute <= 0 ? 0 : Number(
          (await db
            .prepare(
              "SELECT count(*) AS n FROM ai_usage WHERE user_id=? AND started_ms>=?",
              "SELECT count(*) AS n FROM platform_ai_usage WHERE user_id=? AND started_ms>=?",
            )
            .get(userId, minuteAgo))!.n,
        );
      if (limits.requestsPerMinute > 0 && recent >= limits.requestsPerMinute) {
        const oldest = (await db
          .prepare(
            "SELECT min(started_ms) AS started FROM ai_usage WHERE user_id=? AND started_ms>=?",
            "SELECT min(started_ms) AS started FROM platform_ai_usage WHERE user_id=? AND started_ms>=?",
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

      const daily =
        dailyScope === "user"
          ? (await db
              .prepare(
                "SELECT count(*) AS requests,coalesce(sum(total_tokens+reserved_tokens+uncertain_tokens),0) AS tokens FROM ai_usage WHERE started_ms>=? AND user_id=?",
                "SELECT count(*) AS requests,coalesce(sum(total_tokens+reserved_tokens+uncertain_tokens),0) AS tokens FROM platform_ai_usage WHERE started_ms>=? AND user_id=?",
              )
              .get(todayStart(), userId))!
          : (await db
              .prepare(
                `SELECT count(*) AS requests,coalesce(sum(total_tokens+reserved_tokens+uncertain_tokens),0) AS tokens
           FROM ai_usage WHERE started_ms>=?`,
                "SELECT count(*) AS requests,coalesce(sum(total_tokens+reserved_tokens+uncertain_tokens),0) AS tokens\n           FROM platform_ai_usage WHERE started_ms>=?",
              )
              .get(todayStart()))!;
      if (
        !tokensOnly && limits.dailyRequests > 0 &&
        Number(daily.requests) >= limits.dailyRequests
      )
        throw new AiLimitError(
          dailyScope === "user"
            ? "Ваш дневной лимит запросов к ИИ исчерпан. Лимит обновится завтра."
            : "Дневной лимит запросов к ИИ исчерпан. Лимит обновится завтра.",
        );
      if (limits.dailyTokens > 0 && Number(daily.tokens) >= limits.dailyTokens)
        throw new AiLimitError(
          dailyScope === "user"
            ? "Ваш дневной лимит токенов ИИ исчерпан. Лимит обновится завтра."
            : "Дневной лимит токенов ИИ исчерпан. Лимит обновится завтра.",
        );
      return limits.dailyTokens > 0 ? Math.max(0, limits.dailyTokens - Number(daily.tokens)) : null;
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
            "INSERT INTO platform_ai_usage(\n              at,started_ms,user_id,model,status,provider_calls,\n              input_tokens,output_tokens,total_tokens,latency_ms\n            ) VALUES(?,?,?,?,'error',0,0,0,0,0) RETURNING id",
          )
          .run(at, started, userId, model);
      return {
        id: Number(result.lastInsertRowid),
        started,
      };
    },

    /** A platform advisory lock serializes admission across server processes.
     * The input message can be committed in the same transaction by the caller.
     */
    async admit(
      userId: string,
      model: string,
      limits: AiUsageLimits,
      userLimits?: AiUsageLimits,
    ) {
      const work = async () => {
        await lockBudget();
        const remaining = [await store.check(userId, limits)];
        if (userLimits) remaining.push(await store.check(userId, userLimits, "user"));
        const run = await store.begin(userId, model);
        await reserve(run.id, remaining);
        return run;
      };
      return db.inTransaction() ? await work() : await db.transaction(work, false, { archiveLock: "share", graphReadOnly: true });
    },

    /** Settle known progress and reserve the next window before another paid
     * call. Request-count limits are admission-only, never re-applied here. */
    async advance(id: number, userId: string, input: number, output: number,
      limits: AiUsageLimits, userLimits?: AiUsageLimits, uncertainTokens = 0) {
      if (!limits.dailyTokens && !userLimits?.dailyTokens) return 0;
      const work = async () => {
        await lockBudget();
        const row = await db.prepare("SELECT user_id,started_ms FROM ai_usage WHERE id=?",
          "SELECT user_id,started_ms FROM platform_ai_usage WHERE id=?").get(id);
        if (row?.user_id !== userId || Number(row.started_ms) < todayStart())
          throw new AiLimitError("Начались новые сутки. Отправьте запрос ещё раз.");
        const knownInput = Math.max(0, Math.round(input));
        const knownOutput = Math.max(0, Math.round(output));
        await db.prepare(
          "UPDATE ai_usage SET input_tokens=?,output_tokens=?,total_tokens=?,reserved_tokens=0,uncertain_tokens=? WHERE id=?",
          "UPDATE platform_ai_usage SET input_tokens=?,output_tokens=?,total_tokens=?,reserved_tokens=0,uncertain_tokens=? WHERE id=?",
        ).run(knownInput, knownOutput, knownInput + knownOutput, Math.max(0, Math.round(uncertainTokens)), id);
        const remaining = [await store.check(userId, limits, "archive", true)];
        if (userLimits) remaining.push(await store.check(userId, userLimits, "user", true));
        return await reserve(id, remaining);
      };
      return db.inTransaction() ? await work() : await db.transaction(work, false, { archiveLock: "share", graphReadOnly: true });
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
        uncertainTokens?: number;
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
          ,reserved_tokens=0,uncertain_tokens=?
         WHERE id=?`,
          "UPDATE platform_ai_usage SET\n          status=?,provider_calls=?,input_tokens=?,output_tokens=?,\n          total_tokens=?,cached_input_tokens=?,latency_ms=?,reserved_tokens=0,uncertain_tokens=?\n         WHERE id=?",
        )
        .run(
          value.status,
          providerCalls,
          input,
          output,
          input + output,
          Math.max(0, Math.round(value.cachedInputTokens || 0)),
          Math.max(0, Date.now() - started),
          Math.max(0, Math.round(value.uncertainTokens || 0)),
          id,
        );

      const fallbackModel = String(
          (
            await db
              .prepare(
                "SELECT model FROM ai_usage WHERE id=?",
                "SELECT model FROM platform_ai_usage WHERE id=?",
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
          "DELETE FROM platform_ai_usage_models WHERE usage_id=?",
        )
        .run(id);
      const insertModel = db.prepare(
        `INSERT INTO ai_usage_models(
          usage_id,model,provider_calls,input_tokens,output_tokens,total_tokens
        ) VALUES(?,?,?,?,?,?)`,
        "INSERT INTO platform_ai_usage_models(\n          usage_id,model,provider_calls,input_tokens,output_tokens,total_tokens\n        ) VALUES(?,?,?,?,?,?)",
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
      const held = await db.prepare(
        "SELECT coalesce(sum(reserved_tokens+uncertain_tokens),0) AS tokens FROM ai_usage WHERE started_ms>=?",
        "SELECT coalesce(sum(reserved_tokens+uncertain_tokens),0) AS tokens FROM platform_ai_usage WHERE started_ms>=?",
      ).get(todayStart());
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
            "SELECT\n              count(*) AS requests,\n              coalesce(sum(provider_calls),0) AS provider_calls,\n              coalesce(sum(input_tokens),0) AS input_tokens,\n              coalesce(sum(output_tokens),0) AS output_tokens,\n              coalesce(sum(total_tokens),0) AS total_tokens,\n              coalesce(sum(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,\n              coalesce(avg(latency_ms),0) AS average_latency_ms\n             FROM platform_ai_usage WHERE started_ms>=?",
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
            "SELECT\n               to_char(to_timestamp(u.started_ms / 1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,\n               m.model AS model,\n               coalesce(sum(m.provider_calls),0) AS provider_calls,\n               coalesce(sum(m.input_tokens),0) AS input_tokens,\n               coalesce(sum(m.output_tokens),0) AS output_tokens,\n               coalesce(sum(m.total_tokens),0) AS total_tokens\n             FROM platform_ai_usage_models m\n             JOIN platform_ai_usage u ON u.id=m.usage_id\n             WHERE u.started_ms>=?\n             GROUP BY day,m.model\n             ORDER BY day,m.model",
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
            "SELECT id,at,user_id,model,status,provider_calls,input_tokens,\n                    output_tokens,total_tokens,latency_ms\n             FROM platform_ai_usage ORDER BY id DESC LIMIT ?",
          )
          .all(Math.max(1, Math.min(100, limit)));
      return {
        today: {
          reservedTokens: Number(held?.tokens || 0),
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
  return store;
}
