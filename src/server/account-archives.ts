import type { Role } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";
import { AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";

export class AccountArchiveListChanged extends Error {}

export type AccountArchive = {
  id: string;
  title: string;
  role: Role;
  approved: boolean;
  owned: boolean;
  current: boolean;
};

export function accountArchiveDirectory(db: StoreDatabase) {
  const membershipSql = `SELECT a.id,a.title,m.role,m.approved,(o.user_id IS NOT NULL) AS owned
         FROM archive_memberships m
         JOIN archives a ON a.id=m.archive_id
         LEFT JOIN archive_owners o ON o.archive_id=m.archive_id AND o.user_id=m.user_id
         WHERE m.user_id=$1
         ORDER BY lower(a.title),a.id`;
  const mapArchives = (rows: Array<Record<string, unknown>>): AccountArchive[] =>
    rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      role: String(row.role) as Role,
      approved: row.approved === true,
      owned: row.owned === true,
      current: row.id === db.archiveId,
    }));
  const setAccount =
    db.kind === "postgres"
      ? db.prepare("", "SELECT set_config('drevo.account_id',?,true)")
      : null;
  const memberships =
    db.kind === "postgres"
      ? db.prepare(
          "",
          membershipSql,
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
        return mapArchives(rows);
      }, true);
    },
    async deliverList(
      userId: string,
      tokenHash: string,
      expected: AccountArchive[],
      deliver: () => Promise<void>,
    ): Promise<void> {
      if (!db.postgresTransaction)
        throw new AccountSessionExpired("Сессия завершена. Войдите снова");
      try {
        await db.postgresTransaction(async (client) => {
          // Account deletion takes account -> session -> archive locks. A
          // completed revoke fails here; a later one waits for HTTP delivery.
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [userId]);
          if (!account.rowCount)
            throw new AccountSessionExpired("Сессия завершена. Войдите снова");
          const session = await client.query<{ expires_at: string }>(
            `SELECT expires_at FROM account_sessions
             WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [tokenHash, userId],
          );
          if (!session.rows[0] || Number(session.rows[0].expires_at) <= Date.now())
            throw new AccountSessionExpired("Сессия завершена. Войдите снова");
          await client.query("SELECT set_config('drevo.account_id',$1,true)", [userId]);
          // Account-level SELECT policies expose all memberships, but a
          // locking SELECT also uses archive-scoped write policies. Lock each
          // expected archive under its own scope in a stable order, then read
          // the complete account list without row locking for comparison.
          for (const archiveId of [...new Set(expected.map((archive) => archive.id))].sort()) {
            await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
            const archive = await client.query(
              "SELECT id FROM archives WHERE id=$1 FOR SHARE NOWAIT", [archiveId]);
            const membership = await client.query(
              `SELECT archive_id FROM archive_memberships
               WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [archiveId, userId]);
            if (!archive.rowCount || !membership.rowCount)
              throw new AccountArchiveListChanged("Список деревьев изменился. Обновите страницу");
          }
          const rows = await client.query(membershipSql, [userId]);
          if (JSON.stringify(mapArchives(rows.rows)) !== JSON.stringify(expected))
            throw new AccountArchiveListChanged("Список деревьев изменился. Обновите страницу");
          await deliver();
        });
      } catch (error) {
        if ((error as { code?: string }).code === "55P03")
          throw new AccountSessionBusy("Данные аккаунта заняты другим действием. Повторите запрос");
        throw error;
      }
    },
  };
}
