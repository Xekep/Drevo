import type { DatabaseSync } from "node:sqlite";

export type AiUsageLimits = {
  requestsPerMinute: number;
  dailyRequests: number;
  dailyTokens: number;
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
  };
  history: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
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

export function aiUsageStore(db: DatabaseSync) {
  const todayStart = () => {
    const now = new Date(),
      utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return utc;
  };

  return {
    check(userId: string, limits: AiUsageLimits) {
      const now = Date.now(),
        minuteAgo = now - 60_000,
        recent = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM ai_usage WHERE user_id=? AND started_ms>=?",
            )
            .get(userId, minuteAgo)!.n,
        );
      if (limits.requestsPerMinute > 0 && recent >= limits.requestsPerMinute) {
        const oldest = db
          .prepare(
            "SELECT min(started_ms) AS started FROM ai_usage WHERE user_id=? AND started_ms>=?",
          )
          .get(userId, minuteAgo)!.started as number | null;
        const retry = oldest
          ? Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000))
          : 60;
        throw new AiLimitError(
          "Слишком много запросов к ИИ. Повторите позже.",
          retry,
        );
      }

      const daily = db
        .prepare(
          `SELECT count(*) AS requests,coalesce(sum(total_tokens),0) AS tokens
           FROM ai_usage WHERE started_ms>=?`,
        )
        .get(todayStart())!;
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

    begin(userId: string, model: string) {
      const at = new Date().toISOString(),
        started = Date.now(),
        result = db
          .prepare(
            `INSERT INTO ai_usage(
              at,started_ms,user_id,model,status,provider_calls,
              input_tokens,output_tokens,total_tokens,latency_ms
            ) VALUES(?,?,?,?,'error',0,0,0,0,0)`,
          )
          .run(at, started, userId, model);
      return {
        id: Number(result.lastInsertRowid),
        started,
      };
    },

    finish(
      id: number,
      started: number,
      value: {
        status: "ok" | "error";
        providerCalls: number;
        inputTokens: number;
        outputTokens: number;
      },
    ) {
      const input = Math.max(0, Math.round(value.inputTokens)),
        output = Math.max(0, Math.round(value.outputTokens));
      db.prepare(
        `UPDATE ai_usage SET
          status=?,provider_calls=?,input_tokens=?,output_tokens=?,
          total_tokens=?,latency_ms=?
         WHERE id=?`,
      ).run(
        value.status,
        Math.max(0, Math.round(value.providerCalls)),
        input,
        output,
        input + output,
        Math.max(0, Date.now() - started),
        id,
      );
    },

    summary(limit = 20): AiUsageSummary {
      const historyStart = todayStart() - 13 * 86_400_000,
        day = db
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
          )
          .get(todayStart())!,
        historyRows = db
          .prepare(
            `SELECT
               strftime('%Y-%m-%d', started_ms / 1000, 'unixepoch') AS day,
               coalesce(sum(input_tokens),0) AS input_tokens,
               coalesce(sum(output_tokens),0) AS output_tokens,
               coalesce(sum(total_tokens),0) AS total_tokens
             FROM ai_usage
             WHERE started_ms>=?
             GROUP BY day
             ORDER BY day`,
          )
          .all(historyStart),
        rows = db
          .prepare(
            `SELECT id,at,user_id,model,status,provider_calls,input_tokens,
                    output_tokens,total_tokens,latency_ms
             FROM ai_usage ORDER BY id DESC LIMIT ?`,
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
        },
        history: Array.from({ length: 14 }, (_, index) => {
          const date = new Date(historyStart + index * 86_400_000),
            key = date.toISOString().slice(0, 10),
            row = historyRows.find((item) => String(item.day) === key);
          return {
            day: key,
            inputTokens: Number(row?.input_tokens || 0),
            outputTokens: Number(row?.output_tokens || 0),
            totalTokens: Number(row?.total_tokens || 0),
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
