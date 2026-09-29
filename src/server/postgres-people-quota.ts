import type pg from "pg";
import { ForbiddenError } from "./users.ts";

export const BASIC_PEOPLE_LIMIT = 150;

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
  if (!owner) throw new ForbiddenError("Не определён владелец архива");
  const tier = (
    await client.query(
      "SELECT full_access FROM account_tiers WHERE account_id=$1 FOR UPDATE",
      [owner.user_id],
    )
  ).rows[0];
  if (!tier) throw new ForbiddenError("Не определён уровень доступа владельца");
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
  if (count + added > BASIC_PEOPLE_LIMIT)
    throw new ForbiddenError("Базовый доступ владельца ограничен 150 людьми");
}
