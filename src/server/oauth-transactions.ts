import type { DatabaseSync } from "node:sqlite";

export type OAuthTransaction = { verifier: string; expiresAt: number };

/** State is global because the account and archive do not exist yet. */
export type OAuthTransactions = {
  pruneExpired(now: number): void | Promise<void>;
  countPending(now: number): number | Promise<number>;
  create(
    stateHash: string,
    verifier: string,
    expiresAt: number,
  ): void | Promise<void>;
  consume(
    stateHash: string,
    now: number,
  ): OAuthTransaction | null | Promise<OAuthTransaction | null>;
};

export function sqliteOAuthTransactions(db: DatabaseSync): OAuthTransactions {
  const prune = db.prepare("DELETE FROM oauth_transactions WHERE expires_at<?"),
    count = db.prepare(
      "SELECT count(*) AS n FROM oauth_transactions WHERE expires_at>=?",
    ),
    insert = db.prepare(
      "INSERT INTO oauth_transactions(state_hash,verifier,expires_at) VALUES(?,?,?)",
    ),
    take = db.prepare(
      "DELETE FROM oauth_transactions WHERE state_hash=? RETURNING verifier,expires_at",
    );
  return {
    pruneExpired(now) {
      prune.run(now);
    },
    countPending(now) {
      return Number(count.get(now)!.n);
    },
    create(stateHash, verifier, expiresAt) {
      insert.run(stateHash, verifier, expiresAt);
    },
    consume(stateHash, now) {
      const row = take.get(stateHash);
      return row && Number(row.expires_at) >= now
        ? { verifier: String(row.verifier), expiresAt: Number(row.expires_at) }
        : null;
    },
  };
}
