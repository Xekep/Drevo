import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ARCHIVE_SCHEMA_VERSION } from "./schema.ts";
import { provisionPrivateArchiveInTransaction } from "./postgres-private-archive.ts";
import { issuePostgresSessionInTransaction } from "./postgres-sessions.ts";

type YandexProfile = { id: string; name: string };

/** The caller commits before sending the session cookie to the browser. */
export async function completePostgresYandexLoginInTransaction(
  client: pg.Client,
  profile: YandexProfile,
  previousToken = "",
  now = Date.now(),
) {
  const subject = profile.id.trim();
  const name = profile.name.trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(subject))
    throw new Error("Некорректный идентификатор Яндекса");
  if (!name || name.length > 160) throw new Error("Некорректное имя аккаунта");

  // A missing identity has no row to lock. Serialize concurrent callbacks for
  // this provider subject before deciding whether to create an account.
  await client.query("SELECT pg_advisory_xact_lock(2406,hashtext($1))", [
    `yandex:${subject}`,
  ]);
  const identity = await client.query<{ account_id: string }>(
    `SELECT i.account_id FROM account_identities i
       JOIN accounts a ON a.id=i.account_id
      WHERE i.provider='yandex' AND i.subject=$1 FOR UPDATE OF a`,
    [subject],
  );
  let accountId = identity.rows[0]?.account_id;
  const accountCreated = !accountId;
  if (accountId) {
    const tier = await client.query(
      "SELECT 1 FROM account_tiers WHERE account_id=$1",
      [accountId],
    );
    if (!tier.rowCount)
      throw new Error("Для аккаунта не задан уровень доступа");
    await client.query("UPDATE accounts SET name=$2 WHERE id=$1", [
      accountId,
      name,
    ]);
  } else {
    accountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id,name,created_at) VALUES($1,$2,$3)",
      [accountId, name, new Date(now).toISOString()],
    );
    await client.query(
      "INSERT INTO account_identities(provider,subject,account_id) VALUES('yandex',$1,$2)",
      [subject, accountId],
    );
    await client.query("INSERT INTO account_tiers(account_id) VALUES($1)", [
      accountId,
    ]);
  }
  // Existing invited members should return to their approved tree after the
  // migration. Creating an empty personal tree on every legacy login would
  // silently switch their default archive.
  const existingArchive = accountCreated
    ? null
    : (
        await client.query<{ archive_id: string }>(
          `SELECT m.archive_id FROM archive_memberships m
             JOIN archives ar ON ar.id=m.archive_id
             LEFT JOIN archive_owners o
               ON o.archive_id=m.archive_id AND o.user_id=m.user_id
            WHERE m.user_id=$1 AND m.approved
            ORDER BY (o.user_id IS NOT NULL) DESC,lower(ar.title),ar.id
            LIMIT 1`,
          [accountId],
        )
      ).rows[0]?.archive_id;
  const archive = existingArchive
    ? { archiveId: existingArchive, created: false }
    : await provisionPrivateArchiveInTransaction(
        client,
        accountId,
        randomUUID(),
        "Моё древо",
        ARCHIVE_SCHEMA_VERSION,
      );
  const session = await issuePostgresSessionInTransaction(
    client,
    accountId,
    previousToken,
    now,
  );
  return {
    accountId,
    accountCreated,
    archiveId: archive.archiveId,
    archiveCreated: archive.created,
    session,
  };
}
