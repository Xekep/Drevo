import type { ArchiveUser } from "../domain/access.ts";
import { AccountSessionExpired, assertActiveAccountSession } from "./account-session-guard.ts";
import type { StoreDatabase } from "./store-database.ts";

/** Called inside a PostgreSQL archive transaction before pair/publication locks.
 * The archive row is already locked by db.transaction. A completed logout or
 * membership downgrade must fail before any linked fields are delivered.
 */
export async function lockDiscoveryOwnerReadAccess(db: StoreDatabase,
  local: boolean, session: { accountId: string; tokenHash: string } | null,
  user: ArchiveUser): Promise<boolean> {
  if (local) return true;
  if (!db.archiveId) return false;
  if (!session || session.accountId !== user.id) return false;
  try { await assertActiveAccountSession(db, user.id, session.tokenHash); }
  catch (error) {
    if (error instanceof AccountSessionExpired) return false;
    throw error;
  }
  const membership = await db.prepare("", `SELECT role,approved,person_id,tree_access
    FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
    .get(db.archiveId, user.id);
  const owner = await db.prepare("", `SELECT 1 FROM archive_owners
    WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`).get(db.archiveId, user.id);
  return !!owner && membership?.role === (user.treeRole || user.role) &&
    membership.approved === true &&
    (membership.person_id || "") === (user.personId || "") &&
    membership.tree_access === (user.treeAccess || "all");
}
