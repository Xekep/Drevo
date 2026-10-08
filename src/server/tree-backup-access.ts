import type pg from "pg";
import type { StoreDatabase } from "./store-database.ts";
import { PlatformAccessDenied } from "./platform-access.ts";

/** Retain the actual global grant, rather than the archive's legacy admin role. */
export async function lockBackupStaff(client: pg.PoolClient, accountId: string) {
  const admin = await client.query(
    "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT", [accountId]);
  if (admin.rowCount) return true;
  const researcher = await client.query(
    "SELECT account_id FROM platform_researchers WHERE account_id=$1 FOR SHARE NOWAIT", [accountId]);
  return !!researcher.rowCount;
}

/** Only inside the family replacement transaction, never a detached preflight. */
export async function assertTreeBackupInTransaction(db: StoreDatabase, accountId: string) {
  if (db.kind !== "postgres" || !db.inTransaction()) throw new Error("Archive transaction required");
  const member = await db.prepare("", `SELECT approved FROM archive_memberships
    WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`).get(db.archiveId || "", accountId);
  const owner = await db.prepare("", `SELECT user_id FROM archive_owners
    WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`).get(db.archiveId || "", accountId);
  const admin = await db.prepare("", "SELECT account_id FROM platform_admins WHERE account_id=? FOR SHARE NOWAIT").get(accountId);
  const researcher = admin || await db.prepare("", "SELECT account_id FROM platform_researchers WHERE account_id=? FOR SHARE NOWAIT").get(accountId);
  if (!member?.approved || !owner || !researcher)
    throw new PlatformAccessDenied("Доступ к резервным копиям древа отозван");
}
