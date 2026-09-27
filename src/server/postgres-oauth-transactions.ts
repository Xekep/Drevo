import type pg from "pg";
import type { OAuthTransactions } from "./oauth-transactions.ts";

const EXPIRED_CLEANUP_BATCH = 100;

/** Global login transactions; consume is one DELETE RETURNING to prevent replay. */
export function postgresOAuthTransactions(
  client: pg.Client,
): OAuthTransactions {
  return {
    async pruneExpired(now) {
      await client.query(
        `DELETE FROM oauth_transactions WHERE state_hash IN
          (SELECT state_hash FROM oauth_transactions
            WHERE expires_at<$1 ORDER BY expires_at LIMIT $2)`,
        [now, EXPIRED_CLEANUP_BATCH],
      );
    },
    async countPending(now) {
      const result = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM oauth_transactions WHERE expires_at>=$1",
        [now],
      );
      return Number(result.rows[0].n);
    },
    async create(stateHash, verifier, expiresAt) {
      await client.query(
        "INSERT INTO oauth_transactions(state_hash,verifier,expires_at) VALUES($1,$2,$3)",
        [stateHash, verifier, expiresAt],
      );
    },
    async consume(stateHash, now) {
      const result = await client.query<{
        verifier: string;
        expires_at: string;
      }>(
        "DELETE FROM oauth_transactions WHERE state_hash=$1 RETURNING verifier,expires_at",
        [stateHash],
      );
      const row = result.rows[0];
      return row && Number(row.expires_at) >= now
        ? { verifier: row.verifier, expiresAt: Number(row.expires_at) }
        : null;
    },
  };
}
