import type { StoreDatabase } from "./store-database.ts";

export class AccountSessionExpired extends Error {}

/** Hold the session row until the archive mutation commits. A concurrent
 * logout either finishes first and fails this check, or waits for the write.
 */
export async function assertActiveAccountSession(
  db: StoreDatabase,
  accountId: string,
  tokenHash: string,
) {
  const session = await db
    .prepare(
      "",
      `SELECT expires_at FROM account_sessions
       WHERE token_hash=? AND user_id=? FOR SHARE`,
    )
    .get(tokenHash, accountId);
  if (!session || Number(session.expires_at) <= Date.now())
    throw new AccountSessionExpired("Сессия завершена. Войдите снова");
}
