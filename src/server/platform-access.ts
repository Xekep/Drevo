import type pg from "pg";
import type { StoreDatabase } from "./store-database.ts";

export class PlatformAccessDenied extends Error {}
export class PlatformAccessBusy extends Error {}

/** Preliminary platform check; never use this as the only mutation guard. */
export async function hasCurrentPlatformAdmin(
  db: StoreDatabase,
  accountId: string,
  tokenHash: string,
) {
  if (db.kind !== "postgres" || !accountId || !tokenHash) return false;
  const row = await db.prepare("", `SELECT 1 AS allowed FROM accounts a
    JOIN account_sessions s ON s.user_id=a.id
    JOIN platform_admins p ON p.account_id=a.id
    WHERE a.id=? AND s.token_hash=? AND s.expires_at>?`).get(
    accountId, tokenHash, Date.now(),
  );
  return !!row?.allowed;
}

/** Account deletion locks account before session. Never wait across a session
 * row after the account lock, and retain the platform grant through the write. */
export async function assertCurrentPlatformAdmin(
  client: pg.PoolClient,
  accountId: string,
  tokenHash: string,
) {
  try {
    const account = await client.query(
      "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [accountId],
    );
    if (!account.rowCount) throw new PlatformAccessDenied("Аккаунт больше не доступен");
    const session = await client.query<{ expires_at: string }>(
      `SELECT expires_at FROM account_sessions
       WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
      [tokenHash, accountId],
    );
    if (!session.rowCount || Number(session.rows[0].expires_at) <= Date.now())
      throw new PlatformAccessDenied("Сеанс завершён");
    const platform = await client.query(
      "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
      [accountId],
    );
    if (!platform.rowCount)
      throw new PlatformAccessDenied("Права администратора платформы отозваны");
  } catch (error) {
    if ((error as { code?: string }).code === "55P03")
      throw new PlatformAccessBusy("Платформенные права заняты другим действием. Повторите запрос");
    throw error;
  }
}

/** Use only inside db.transaction(), where prepare shares its retained client. */
export async function assertPlatformAdminInArchiveTransaction(
  db: StoreDatabase,
  accountId: string,
  tokenHash: string,
) {
  if (db.kind !== "postgres" || !db.inTransaction())
    throw new Error("Archive transaction required");
  try {
    const account = await db.prepare("",
      "SELECT id FROM accounts WHERE id=? FOR SHARE NOWAIT").get(accountId);
    const session = await db.prepare("",
      `SELECT expires_at FROM account_sessions
       WHERE token_hash=? AND user_id=? FOR SHARE NOWAIT`)
      .get(tokenHash, accountId);
    const admin = await db.prepare("",
      "SELECT account_id FROM platform_admins WHERE account_id=? FOR SHARE NOWAIT")
      .get(accountId);
    if (!account || !session || Number(session.expires_at) <= Date.now() || !admin)
      throw new PlatformAccessDenied("Права администратора платформы отозваны");
  } catch (error) {
    if ((error as { code?: string }).code === "55P03")
      throw new PlatformAccessBusy("Платформенные права заняты другим действием");
    throw error;
  }
}
