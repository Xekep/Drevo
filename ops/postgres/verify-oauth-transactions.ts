import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { postgresOAuthTransactions } from "../../src/server/postgres-oauth-transactions.ts";

export async function verifyOAuthTransactions(
  client: pg.Client,
  now = Date.now(),
) {
  const databaseName = String(
    (await client.query("SELECT current_database() AS name")).rows[0]?.name ||
      "",
  );
  if (!/^drevo_migration(?:_|$)/.test(databaseName))
    throw new Error(
      "Проверка OAuth разрешена только в изолированной migration-базе",
    );
  await client.query("BEGIN");
  try {
    await client.query(
      readFileSync(
        new URL("./006_oauth_transactions.sql", import.meta.url),
        "utf8",
      ),
    );
    const store = postgresOAuthTransactions(client);
    const originalCount = await store.countPending(now);
    const stateHash = createHash("sha256")
      .update(randomBytes(32))
      .digest("hex");
    const verifier = randomBytes(32).toString("base64url");
    await store.create(stateHash, verifier, now + 60_000);
    assert.equal(await store.countPending(now), originalCount + 1);
    assert.deepEqual(await store.consume(stateHash, now), {
      verifier,
      expiresAt: now + 60_000,
    });
    assert.equal(await store.consume(stateHash, now), null);

    const expiredHash = createHash("sha256")
      .update(randomBytes(32))
      .digest("hex");
    await store.create(expiredHash, verifier, now - 1);
    assert.equal(await store.consume(expiredHash, now), null);
    const prunedHash = createHash("sha256")
      .update(randomBytes(32))
      .digest("hex");
    await store.create(prunedHash, verifier, now - 1);
    assert.equal(await store.countPending(now), originalCount);
    await store.pruneExpired(now);
    assert.equal(await store.consume(prunedHash, now), null);
    assert.equal(await store.countPending(now), originalCount);
    await client.query("ROLLBACK");
    return { databaseName, originalCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(JSON.stringify(await verifyOAuthTransactions(client)));
  } finally {
    await client.end();
  }
}
