import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { completePostgresYandexLoginInTransaction } from "../../src/server/postgres-yandex-login.ts";
import { sessionTokenHash } from "../../src/server/session-token.ts";

export async function verifyYandexLogin(client: pg.Client, now = Date.now()) {
  const databaseName = String(
    (await client.query("SELECT current_database() AS name")).rows[0]?.name ||
      "",
  );
  if (!/^drevo_migration(?:_|$)/.test(databaseName))
    throw new Error("Проверка входа разрешена только в migration-базе");
  const before = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM accounts",
  );
  const identityTable = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('account_identities') AS table_name",
  );
  if (identityTable.rows[0].table_name) {
    const imported = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM account_identities WHERE provider='yandex'",
    );
    assert.equal(imported.rows[0].n, before.rows[0].n);
  }
  await client.query("BEGIN");
  try {
    await client.query(
      readFileSync(
        new URL("./007_account_identities.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query(
      `INSERT INTO account_identities(provider,subject,account_id)
       SELECT 'yandex',id,id FROM accounts
       ON CONFLICT (provider,subject) DO NOTHING`,
    );
    const legacy = (
      await client.query<{ id: string; name: string }>(
        "SELECT id,name FROM accounts ORDER BY id LIMIT 1",
      )
    ).rows[0];
    assert.ok(
      legacy,
      "The migration snapshot must contain an existing account",
    );
    const first = await completePostgresYandexLoginInTransaction(
      client,
      legacy,
      "",
      now,
    );
    assert.equal(first.accountId, legacy.id);
    assert.equal(first.accountCreated, false);
    const again = await completePostgresYandexLoginInTransaction(
      client,
      legacy,
      first.session.token,
      now + 1000,
    );
    assert.equal(again.archiveId, first.archiveId);
    assert.equal(again.archiveCreated, false);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM account_sessions WHERE token_hash=$1",
          [sessionTokenHash(first.session.token)],
        )
      ).rowCount,
      0,
    );
    const invited = (
      await client.query<{ id: string; name: string; archive_id: string }>(
        `SELECT a.id,a.name,m.archive_id FROM accounts a
           JOIN archive_memberships m ON m.user_id=a.id AND m.approved
           LEFT JOIN archive_owners o ON o.user_id=a.id
          WHERE o.user_id IS NULL ORDER BY a.id LIMIT 1`,
      )
    ).rows[0];
    assert.ok(invited, "The snapshot must include an invited member");
    const returned = await completePostgresYandexLoginInTransaction(
      client,
      invited,
      "",
      now,
    );
    assert.equal(returned.archiveId, invited.archive_id);
    assert.equal(returned.archiveCreated, false);
    assert.equal(
      (
        await client.query("SELECT 1 FROM archive_owners WHERE user_id=$1", [
          invited.id,
        ])
      ).rowCount,
      0,
    );

    const subject = `probe-${randomUUID()}`;
    const created = await completePostgresYandexLoginInTransaction(
      client,
      { id: subject, name: "Проверка нового аккаунта" },
      "",
      now,
    );
    assert.equal(created.accountCreated, true);
    assert.equal(created.archiveCreated, true);
    assert.notEqual(created.accountId, subject);
    const retry = await completePostgresYandexLoginInTransaction(
      client,
      { id: subject, name: "Новое имя" },
      created.session.token,
      now + 1000,
    );
    assert.equal(retry.accountId, created.accountId);
    assert.equal(retry.archiveId, created.archiveId);
    assert.equal(retry.archiveCreated, false);
    const settings = (
      await client.query<{
        name: string;
        public_tree: boolean;
        public_albums: boolean;
        people: string;
        owners: string;
      }>(
        `SELECT a.name,s.public_tree,s.public_albums,
                (SELECT count(*) FROM people WHERE archive_id=$1) AS people,
                (SELECT count(*) FROM archive_owners WHERE user_id=$2) AS owners
           FROM accounts a JOIN archive_access_settings s ON s.archive_id=$1
          WHERE a.id=$2`,
        [created.archiveId, created.accountId],
      )
    ).rows[0];
    assert.deepEqual(settings, {
      name: "Новое имя",
      public_tree: false,
      public_albums: false,
      people: "0",
      owners: "1",
    });
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query<{ n: string }>("SELECT count(*) AS n FROM accounts"))
        .rows[0].n,
      before.rows[0].n,
    );
    return { databaseName, existingAccounts: Number(before.rows[0].n) };
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
    console.log(JSON.stringify(await verifyYandexLogin(client)));
  } finally {
    await client.end();
  }
}
