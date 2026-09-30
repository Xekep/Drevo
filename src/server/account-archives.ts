import type { Role } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";

export type AccountArchive = {
  id: string;
  title: string;
  role: Role;
  approved: boolean;
  current: boolean;
};

export function accountArchiveDirectory(db: StoreDatabase) {
  const setAccount =
    db.kind === "postgres"
      ? db.prepare("", "SELECT set_config('drevo.account_id',?,true)")
      : null;
  const memberships =
    db.kind === "postgres"
      ? db.prepare(
          "",
          `SELECT a.id,a.title,m.role,m.approved
         FROM archive_memberships m
         JOIN archives a ON a.id=m.archive_id
         WHERE m.user_id=?
         ORDER BY lower(a.title),a.id`,
        )
      : null;
  const approvedMembership =
    db.kind === "postgres"
      ? db.prepare(
          "",
          "SELECT 1 FROM archive_memberships WHERE archive_id=? AND user_id=? AND approved=true",
        )
      : null;

  return {
    async contains(userId: string, archiveId: string): Promise<boolean> {
      if (!setAccount || !approvedMembership) return false;
      return await db.transaction(async () => {
        await setAccount.get(userId);
        return !!(await approvedMembership.get(archiveId, userId));
      }, true);
    },
    async list(userId: string): Promise<AccountArchive[] | null> {
      if (!setAccount || !memberships) return null;
      return await db.transaction(async () => {
        // Both RLS exceptions apply only inside this read-only transaction.
        await setAccount.get(userId);
        const rows = await memberships.all(userId);
        return rows.map((row) => ({
          id: String(row.id),
          title: String(row.title),
          role: String(row.role) as Role,
          approved: row.approved === true,
          current: row.id === db.archiveId,
        }));
      }, true);
    },
  };
}
