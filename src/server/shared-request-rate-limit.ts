import { createHash, randomInt } from "node:crypto";
import { createRequestLimiter } from "./request-rate-limit.ts";
import type { StoreDatabase } from "./store-database.ts";

const RETENTION_MS = 24 * 60 * 60 * 1000;

/** An atomic, process-independent budget for costly and public endpoints. */
export function createSharedRequestLimiter(
  db: StoreDatabase | undefined,
  scope: string,
  { windowMs, limit }: { windowMs: number; limit: number },
) {
  if (!/^[a-z0-9:_-]{1,80}$/.test(scope))
    throw new Error("Invalid request limiter scope");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000)
    throw new Error("Invalid request limiter budget");
  if (db?.kind !== "postgres") {
    const local = createRequestLimiter({ windowMs, limit });
    return { allow: async (key: string) => local.allow(key) };
  }
  if (!db.postgresTransaction)
    throw new Error("PostgreSQL request limiter requires transactions");
  const transact = db.postgresTransaction;
  return {
    async allow(key: string) {
      const digest = createHash("sha256").update(key).digest("hex");
      return await transact(async (client) => {
        // Bounded, occasional cleanup avoids an unbounded set of one-off IPs.
        if (randomInt(100) === 0)
          await client.query(
            `WITH old AS (SELECT scope,key_hash FROM request_rate_limits
              WHERE started_at < floor(extract(epoch FROM statement_timestamp())*1000)::bigint-$1
              ORDER BY started_at LIMIT 100)
             DELETE FROM request_rate_limits r USING old
              WHERE r.scope=old.scope AND r.key_hash=old.key_hash`,
            [RETENTION_MS],
          );
        const result = await client.query<{ attempts: number }>(
          `INSERT INTO request_rate_limits(scope,key_hash,started_at,attempts)
           VALUES($1,$2,floor(extract(epoch FROM statement_timestamp())*1000)::bigint,1)
           ON CONFLICT(scope,key_hash) DO UPDATE SET
             started_at=CASE WHEN request_rate_limits.started_at <=
               floor(extract(epoch FROM statement_timestamp())*1000)::bigint-$3
               THEN floor(extract(epoch FROM statement_timestamp())*1000)::bigint
               ELSE request_rate_limits.started_at END,
             attempts=CASE WHEN request_rate_limits.started_at <=
               floor(extract(epoch FROM statement_timestamp())*1000)::bigint-$3
               THEN 1 ELSE LEAST(request_rate_limits.attempts+1,$4) END
           RETURNING attempts`,
          [scope, digest, windowMs, limit + 1],
        );
        return result.rows[0].attempts <= limit;
      });
    },
  };
}
