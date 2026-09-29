import type { StoreDatabase } from "./store-database.ts";

/** Both the account and the owner of the active archive must have full access. */
export async function accountAiAccess(
  db: StoreDatabase,
  accountId: string,
  trustedLocal = false,
) {
  if (trustedLocal || db.kind === "sqlite") return true;
  const row = await db
    .prepare(
      "",
      `SELECT viewer.full_access AS viewer_full,
              owner_tier.full_access AS owner_full
         FROM account_tiers viewer
         JOIN archive_owners owner
           ON owner.archive_id=current_setting('drevo.archive_id', true)
         JOIN account_tiers owner_tier ON owner_tier.account_id=owner.user_id
        WHERE viewer.account_id=?`,
    )
    .get(accountId);
  return row?.viewer_full === true && row.owner_full === true;
}
