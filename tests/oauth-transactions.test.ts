import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqliteOAuthTransactions } from "../src/server/oauth-transactions.ts";

test("OAuth state is consumed once and expired states do not count as pending", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE oauth_transactions(state_hash TEXT PRIMARY KEY,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL)",
    );
    const store = sqliteOAuthTransactions(db);
    store.create("expired", "verifier", 99);
    assert.equal(store.countPending(100), 0);
    assert.equal(store.consume("expired", 100), null);
    store.create("fresh", "verifier", 101);
    assert.equal(store.countPending(100), 1);
    assert.deepEqual(store.consume("fresh", 100), {
      verifier: "verifier",
      expiresAt: 101,
    });
    assert.equal(store.consume("fresh", 100), null);
  } finally {
    db.close();
  }
});
