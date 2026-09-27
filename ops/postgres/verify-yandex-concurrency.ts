import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { completePostgresYandexLoginInTransaction } from "../../src/server/postgres-yandex-login.ts";

/** Commits test rows, so run only in a disposable migration_concurrency DB. */
export async function verifyConcurrentYandexLogin() {
  const firstClient = new pg.Client({ connectionTimeoutMillis: 5000 });
  const secondClient = new pg.Client({ connectionTimeoutMillis: 5000 });
  await firstClient.connect();
  try {
    await secondClient.connect();
    const databaseName = String(
      (await firstClient.query("SELECT current_database() AS name")).rows[0]
        ?.name || "",
    );
    if (!/^drevo_migration_concurrency_[a-z0-9_]+$/.test(databaseName))
      throw new Error(
        "Параллельная проверка требует временную concurrency-базу",
      );
    const subject = `probe-${randomUUID()}`;
    const profile = { id: subject, name: "Проверка параллельного входа" };
    await firstClient.query("BEGIN");
    await secondClient.query("BEGIN");
    const first = await completePostgresYandexLoginInTransaction(
      firstClient,
      profile,
    );
    let secondSettled = false;
    const secondPromise = completePostgresYandexLoginInTransaction(
      secondClient,
      profile,
    ).finally(() => {
      secondSettled = true;
    });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(
      secondSettled,
      false,
      "Second callback must wait for the first",
    );
    await firstClient.query("COMMIT");
    const second = await secondPromise;
    assert.equal(second.accountId, first.accountId);
    assert.equal(second.archiveId, first.archiveId);
    assert.equal(second.accountCreated, false);
    assert.equal(second.archiveCreated, false);
    await secondClient.query("COMMIT");
    const counts = (
      await firstClient.query<{ identities: string; owners: string }>(
        `SELECT
          (SELECT count(*) FROM account_identities
            WHERE provider='yandex' AND subject=$1) AS identities,
          (SELECT count(*) FROM archive_owners WHERE user_id=$2) AS owners`,
        [subject, first.accountId],
      )
    ).rows[0];
    assert.deepEqual(counts, { identities: "1", owners: "1" });
    return { databaseName, callbacks: 2, accounts: 1, archives: 1 };
  } finally {
    await firstClient.query("ROLLBACK").catch(() => {});
    await secondClient.query("ROLLBACK").catch(() => {});
    await firstClient.end();
    await secondClient.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(JSON.stringify(await verifyConcurrentYandexLogin()));
