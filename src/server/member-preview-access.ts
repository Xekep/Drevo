import type { IncomingMessage } from "node:http";
import type pg from "pg";
import type { ArchiveUser } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";

// A request tag selects a read subject. It never replaces the owner's cookie
// or grants a write capability to the selected member.
const selected = new WeakMap<IncomingMessage, string>();

export function setMemberPreviewTarget(req: IncomingMessage, memberId: string) {
  selected.set(req, memberId);
}

export function memberPreviewTarget(req: IncomingMessage) {
  return selected.get(req) || null;
}

export function samePreviewMember(
  current: ArchiveUser | null,
  selectedMember: ArchiveUser,
) {
  return !!current && current.id === selectedMember.id &&
    current.role === selectedMember.role &&
    current.approved === selectedMember.approved &&
    (current.personId || "") === (selectedMember.personId || "") &&
    (current.treeAccess || "all") === (selectedMember.treeAccess || "all") &&
    !!current.archiveOwner === !!selectedMember.archiveOwner;
}

/** Called after the archive row is locked and before any preview bytes leave.
 * Existing read handlers retain their own document/media/revision checks.
 */
export async function assertMemberPreviewDelivery(
  client: pg.Client,
  archiveId: string,
  owner: { accountId: string; tokenHash: string },
  target: ArchiveUser,
) {
  await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
  await client.query("SELECT set_config('drevo.account_id',$1,true)", [owner.accountId]);
  const archive = await client.query(
    "SELECT id FROM archives WHERE id=$1 FOR SHARE NOWAIT", [archiveId]);
  if (!archive.rowCount) return null;
  const session = await client.query<{ expires_at: string }>(
    `SELECT expires_at FROM account_sessions WHERE token_hash=$1 AND user_id=$2
     FOR SHARE NOWAIT`, [owner.tokenHash, owner.accountId]);
  const expiresAt = Number(session.rows[0]?.expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
  const ownerGrant = await client.query(
    `SELECT 1 FROM archive_owners WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
    [archiveId, owner.accountId]);
  const ownerMember = await client.query<{ approved: boolean }>(
    `SELECT approved FROM archive_memberships WHERE archive_id=$1 AND user_id=$2
     FOR SHARE NOWAIT`, [archiveId, owner.accountId]);
  if (!ownerGrant.rowCount || ownerMember.rows[0]?.approved !== true) return null;
  const membership = await client.query<{
    role: string; approved: boolean; person_id: string | null; tree_access: string;
  }>(
    `SELECT role,approved,person_id,tree_access FROM archive_memberships
     WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
    [archiveId, target.id]);
  const current = membership.rows[0];
  if (!current || current.role !== target.role ||
      current.approved !== target.approved ||
      (current.person_id || "") !== (target.personId || "") ||
      (current.tree_access || "all") !== (target.treeAccess || "all")) return null;
  const targetOwner = await client.query(
    `SELECT 1 FROM archive_owners WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
    [archiveId, target.id]);
  return !!targetOwner.rowCount === !!target.archiveOwner ? expiresAt : null;
}

/** StoreDatabase.transaction keeps these reads on its locked archive client. */
export async function assertMemberPreviewStoreDelivery(
  db: StoreDatabase,
  owner: { accountId: string; tokenHash: string },
  target: ArchiveUser,
) {
  if (db.kind !== "postgres" || !db.archiveId) return null;
  const session = await db.prepare("", `SELECT expires_at FROM account_sessions
    WHERE token_hash=? AND user_id=? FOR SHARE NOWAIT`)
    .get(owner.tokenHash, owner.accountId);
  const expiresAt = Number(session?.expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
  const grant = await db.prepare("", `SELECT 1 FROM archive_owners
    WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
    .get(db.archiveId, owner.accountId);
  const ownerMember = await db.prepare("", `SELECT approved FROM archive_memberships
    WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
    .get(db.archiveId, owner.accountId);
  if (!grant || ownerMember?.approved !== true) return null;
  const member = await db.prepare("", `SELECT role,approved,person_id,tree_access
    FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
    .get(db.archiveId, target.id);
  if (!member || member.role !== target.role ||
      member.approved !== target.approved ||
      (member.person_id || "") !== (target.personId || "") ||
      (member.tree_access || "all") !== (target.treeAccess || "all")) return null;
  const ownerRow = await db.prepare("", `SELECT 1 FROM archive_owners
    WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
    .get(db.archiveId, target.id);
  return !!ownerRow === !!target.archiveOwner ? expiresAt : null;
}
