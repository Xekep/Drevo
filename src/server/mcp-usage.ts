import type { DatabaseSync } from "node:sqlite";

export class McpRateLimitError extends Error {
  retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function mcpUsageStore(db: DatabaseSync) {
  const todayStart = () => {
    const now = new Date();
    return Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
  };

  return {
    check(tokenId: string, requestsPerMinute: number) {
      if (requestsPerMinute <= 0) return;
      const now = Date.now(),
        since = now - 60_000,
        row = db
          .prepare(
            `SELECT count(*) AS n,min(started_ms) AS oldest
             FROM mcp_usage WHERE token_id=? AND started_ms>=?`,
          )
          .get(tokenId, since)!;
      if (Number(row.n) < requestsPerMinute) return;
      const oldest = row.oldest ? Number(row.oldest) : now;
      throw new McpRateLimitError(
        "Слишком много MCP-запросов. Повторите позже.",
        Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
      );
    },

    begin(tokenId: string, method: string, toolName?: string) {
      const started = Date.now(),
        result = db
          .prepare(
            `INSERT INTO mcp_usage(
              at,started_ms,token_id,method,tool_name,status,latency_ms
            ) VALUES(
              strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?,?, 'error',0
            )`,
          )
          .run(started, tokenId, method, toolName || null);
      return { id: Number(result.lastInsertRowid), started };
    },

    finish(id: number, started: number, status: "ok" | "error") {
      db.prepare(
        "UPDATE mcp_usage SET status=?,latency_ms=? WHERE id=?",
      ).run(status, Math.max(0, Date.now() - started), id);
    },

    tokenSummary(tokenId: string) {
      const row = db
        .prepare(
          `SELECT
            count(*) AS calls,
            coalesce(sum(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,
            coalesce(avg(latency_ms),0) AS average_latency_ms
           FROM mcp_usage
           WHERE token_id=? AND started_ms>=?`,
        )
        .get(tokenId, todayStart())!;
      return {
        callsToday: Number(row.calls),
        errorsToday: Number(row.errors),
        averageLatencyMs: Math.round(Number(row.average_latency_ms)),
      };
    },

    recent(limit = 50) {
      return db
        .prepare(
          `SELECT id,at,token_id,method,tool_name,status,latency_ms
           FROM mcp_usage ORDER BY id DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(200, limit)))
        .map((row) => ({
          id: Number(row.id),
          at: String(row.at),
          tokenId: String(row.token_id),
          method: String(row.method),
          ...(row.tool_name ? { toolName: String(row.tool_name) } : {}),
          status: String(row.status) as "ok" | "error",
          latencyMs: Number(row.latency_ms),
        }));
    },
  };
}
