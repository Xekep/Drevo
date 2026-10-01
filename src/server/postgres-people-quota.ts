import type pg from "pg";
import type { StoreDatabase } from "./store-database.ts";
import { ForbiddenError } from "./users.ts";

export const BASIC_PEOPLE_LIMIT = 150;

const missingOwner = () => new ForbiddenError("Не определён владелец архива");
const missingTier = () => new ForbiddenError("Не определён уровень доступа владельца");
const peopleLimit = () => new ForbiddenError("Базовый доступ владельца ограничен 150 людьми");

/** Called after the archive/session/membership locks, before any people INSERT.
 * Quota belongs to the owner, not the editor. Tier lock also serializes creation
 * across owned archives and prevents a concurrent tier change until commit.
 */
export async function checkPostgresPeopleGrowth(
  client: pg.Client,
  archiveId: string,
  added: number,
) {
  if (added <= 0) return;
  const owner = (
    await client.query(
      "SELECT user_id FROM archive_owners WHERE archive_id=$1 FOR SHARE",
      [archiveId],
    )
  ).rows[0];
  if (!owner) throw missingOwner();
  const tier = (
    await client.query(
      "SELECT full_access FROM account_tiers WHERE account_id=$1 FOR UPDATE",
      [owner.user_id],
    )
  ).rows[0];
  if (!tier) throw missingTier();
  if (tier.full_access) return;
  const count = Number(
    (
      await client.query(
        `SELECT count(*) AS count FROM people p
       JOIN archive_owners o ON o.archive_id=p.archive_id WHERE o.user_id=$1`,
        [owner.user_id],
      )
    ).rows[0].count,
  );
  if (count + added > BASIC_PEOPLE_LIMIT) throw peopleLimit();
}

/** The full-snapshot write path uses StoreDatabase's current archive transaction.
 * Lock the owner's tier before counting so concurrent archive writes and tier
 * changes cannot each observe spare capacity and commit beyond the limit.
 */
export async function checkStorePostgresPeopleGrowth(
  db: StoreDatabase,
  added: number,
) {
  if (db.kind !== "postgres" || added <= 0) return;
  if (!db.inTransaction())
    throw new Error("Проверка квоты людей требует транзакции архива");
  const owner = await db
    .prepare(
      "",
      `SELECT user_id FROM archive_owners
       WHERE archive_id=current_setting('drevo.archive_id', true) FOR SHARE`,
    )
    .get();
  // Legacy shared archives have no personal owner and therefore no account
  // whose basic tier can be charged. Their pre-existing write path remains.
  if (!owner) return;
  const tier = await db
    .prepare(
      "",
      "SELECT full_access FROM account_tiers WHERE account_id=? FOR UPDATE",
    )
    .get(String(owner.user_id));
  if (!tier) throw missingTier();
  if (tier.full_access) return;
  const count = await db
    .prepare(
      "",
      `SELECT count(*) AS count FROM people p
       JOIN archive_owners o ON o.archive_id=p.archive_id WHERE o.user_id=?`,
    )
    .get(String(owner.user_id));
  if (Number(count?.count || 0) + added > BASIC_PEOPLE_LIMIT)
    throw peopleLimit();
}
