import type { StoreDatabase } from "./store-database.ts";

export class AccountSessionExpired extends Error {}
export class AccountSessionBusy extends Error {}

/** Hold the session row until the archive mutation commits. An earlier
 * session mutation gets a retryable conflict; a later one waits for commit.
 */
export async function assertActiveAccountSession(
  db: StoreDatabase,
  accountId: string,
  tokenHash: string,
) {
  let session: Record<string, unknown> | undefined;
  try {
    // Archive mutations hold the archive row first. Account deletion holds
    // the session before locking its memberships' archives, so waiting here
    // could form a cross-transaction cycle.
    session = await db
      .prepare(
        "SELECT user_id,expires_at FROM auth_sessions WHERE token_hash=? AND user_id=?",
        `SELECT expires_at FROM account_sessions
         WHERE token_hash=? AND user_id=? FOR SHARE NOWAIT`,
      )
      .get(tokenHash, accountId);
  } catch (error) {
    if ((error as { code?: string }).code === "55P03")
      throw new AccountSessionBusy("Сеанс занят другим действием. Повторите запрос");
    throw error;
  }
  if (!session || Number(session.expires_at) <= Date.now())
    throw new AccountSessionExpired("Сессия завершена. Войдите снова");
}
