import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ARCHIVE_SCHEMA_VERSION } from "./schema.ts";
import { provisionPrivateArchiveInTransaction } from "./postgres-private-archive.ts";
import { issuePostgresSessionInTransaction } from "./postgres-sessions.ts";

type OAuthProfile = { id: string; name: string };
type Provider = "yandex" | "vk";

/** The caller commits before sending the session cookie to the browser. */
export async function completePostgresOAuthLoginInTransaction(
  client: pg.Client,
  provider: Provider,
  profile: OAuthProfile,
  previousToken = "",
  now = Date.now(),
) {
  const subject =
    provider === "vk" ? profile.id.replace(/^vk:/, "") : profile.id.trim();
  const name = profile.name.trim();
  if (
    provider === "vk"
      ? !/^vk:[0-9]{1,32}$/.test(profile.id)
      : !/^[A-Za-z0-9_-]{1,100}$/.test(subject)
  )
    throw new Error("Некорректный идентификатор провайдера");
  if (!name || name.length > 160) throw new Error("Некорректное имя аккаунта");

  // A missing identity has no row to lock. Serialize concurrent callbacks for
  // this provider subject before deciding whether to create an account.
  await client.query("SELECT pg_advisory_xact_lock(2406,hashtext($1))", [
    `${provider}:${subject}`,
  ]);
  const identity = await client.query<{ account_id: string }>(
    `SELECT i.account_id FROM account_identities i
       JOIN accounts a ON a.id=i.account_id
      WHERE i.provider=$1 AND i.subject=$2 FOR UPDATE OF a`,
    [provider, subject],
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
      "INSERT INTO account_identities(provider,subject,account_id) VALUES($1,$2,$3)",
      [provider, subject, accountId],
    );
    await client.query("INSERT INTO account_tiers(account_id) VALUES($1)", [
      accountId,
    ]);
  }
  // The account-scoped SELECT policies reveal only this account's memberships
  // and owned archive. The setting expires with this transaction.
  await client.query("SELECT set_config('drevo.account_id',$1,true)", [
    accountId,
  ]);
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
    : await (async () => {
        const archiveId = randomUUID();
        // The new tree's INSERT policies remain bound to archive_id.
        await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
          archiveId,
        ]);
        return await provisionPrivateArchiveInTransaction(
          client,
          accountId,
          archiveId,
          "Моё древо",
          ARCHIVE_SCHEMA_VERSION,
        );
      })();
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

export async function completePostgresYandexLoginInTransaction(
  client: pg.Client,
  profile: OAuthProfile,
  previousToken = "",
  now = Date.now(),
) {
  return await completePostgresOAuthLoginInTransaction(
    client,
    "yandex",
    profile,
    previousToken,
    now,
  );
}
