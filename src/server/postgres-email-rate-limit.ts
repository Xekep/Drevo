import { createHash, randomInt } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";

const WINDOW_MS = 10 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Atomic limits shared by every process; no plaintext addresses are retained. */
export function postgresEmailRateLimit(db: StoreDatabase, now = Date.now) {
  if (!db.postgresTransaction) throw new Error("Требуется PostgreSQL.");
  const transact = db.postgresTransaction;
  return {
    async allow(ip: string, email = "") {
      const time = now();
      return await transact(async (client) => {
        // One bounded cleanup per ~100 requests keeps unique attack keys from
        // growing forever without putting a table-wide sweep on every login.
        if (randomInt(100) === 0)
          await client.query(
            `WITH old AS (SELECT scope,key_hash FROM email_auth_rate_limits
              WHERE started_at<$1 ORDER BY started_at LIMIT 100)
             DELETE FROM email_auth_rate_limits r USING old
              WHERE r.scope=old.scope AND r.key_hash=old.key_hash`,
            [time - RETENTION_MS],
          );
        for (const [scope, key, limit] of [
          ["ip", ip, 25],
          ...(email ? [["email", email, 8]] : []),
        ] as ["ip" | "email", string, number][]) {
          const result = await client.query<{ attempts: number }>(
            `INSERT INTO email_auth_rate_limits(scope,key_hash,started_at,attempts)
             VALUES($1,$2,$3,1)
             ON CONFLICT(scope,key_hash) DO UPDATE SET
               started_at=CASE WHEN email_auth_rate_limits.started_at<=$4
                 THEN $3 ELSE email_auth_rate_limits.started_at END,
               attempts=CASE WHEN email_auth_rate_limits.started_at<=$4
                 THEN 1 ELSE LEAST(email_auth_rate_limits.attempts+1,$5) END
             RETURNING attempts`,
            [scope, hash(key), time, time - WINDOW_MS, limit + 1],
          );
          if (result.rows[0].attempts > limit) return false;
        }
        return true;
      });
    },
  };
}
