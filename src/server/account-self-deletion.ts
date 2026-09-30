import type { StoreDatabase } from "./store-database.ts";

const DELETED_ACTOR = "deleted-account";
const DELETED_NAME = "Удалённый участник";

export class AccountDeletionConflict extends Error {}

export function accountSelfDeletion(db: StoreDatabase, enabled: boolean) {
  const available =
    enabled && db.kind === "postgres" && !!db.postgresTransaction;

  async function summary(accountId: string, lock: boolean) {
    if (!available || !db.postgresTransaction) return null;
    return await db.postgresTransaction(async (client) => {
      const account = await client.query(
        `SELECT name FROM accounts WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [accountId],
      );
      if (!account.rowCount) return null;
      await client.query("SELECT set_config('drevo.account_id',$1,true)", [
        accountId,
      ]);
      const owned = await client.query(
        "SELECT count(*)::integer AS total FROM archive_owners WHERE user_id=$1",
        [accountId],
      );
      const memberships = await client.query(
        "SELECT count(*)::integer AS total FROM archive_memberships WHERE user_id=$1",
        [accountId],
      );
      return {
        name: String(account.rows[0].name),
        ownedArchives: Number(owned.rows[0].total),
        sharedArchives: Number(memberships.rows[0].total),
      };
    });
  }

  return {
    available,
    preview: (accountId: string) => summary(accountId, false),
    async remove(
      accountId: string,
      confirmation: { name: string; leaveSharedArchives: boolean },
    ) {
      if (!available || !db.postgresTransaction)
        throw new AccountDeletionConflict("Удаление здесь недоступно");
      return await db.postgresTransaction(async (client) => {
        const account = await client.query(
          "SELECT name FROM accounts WHERE id=$1 FOR UPDATE",
          [accountId],
        );
        if (!account.rowCount)
          throw new AccountDeletionConflict("Аккаунт уже удалён");
        const name = String(account.rows[0].name);
        if (confirmation.name !== name)
          throw new AccountDeletionConflict("Имя аккаунта не совпало");
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [
          accountId,
        ]);
        const owned = await client.query(
          "SELECT 1 FROM archive_owners WHERE user_id=$1 LIMIT 1",
          [accountId],
        );
        if (owned.rowCount)
          throw new AccountDeletionConflict(
            "Сначала передайте или удалите собственное дерево",
          );
        const platformAdmins = await client.query<{ account_id: string }>(
          "SELECT account_id FROM platform_admins ORDER BY account_id FOR UPDATE",
        );
        if (
          platformAdmins.rowCount === 1 &&
          platformAdmins.rows[0].account_id === accountId
        )
          throw new AccountDeletionConflict(
            "Сначала назначьте другого администратора платформы",
          );
        const memberships = await client.query<{ archive_id: string }>(
          "SELECT archive_id FROM archive_memberships WHERE user_id=$1 ORDER BY archive_id",
          [accountId],
        );
        if (memberships.rowCount && !confirmation.leaveSharedArchives)
          throw new AccountDeletionConflict(
            "Подтвердите выход из остальных деревьев",
          );

        for (const { archive_id: archiveId } of memberships.rows) {
          await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
            archiveId,
          ]);
          await client.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE", [
            archiveId,
          ]);
          // Shared genealogical facts and the action history stay in the
          // archive, but must no longer expose the departed account's name.
          await client.query(
            "UPDATE archive_audit_entries SET actor_id=$2,actor_name=$3 WHERE actor_id=$1",
            [accountId, DELETED_ACTOR, DELETED_NAME],
          );
          await client.query(
            "UPDATE person_comments SET author_id=$2,author_name=$3 WHERE author_id=$1",
            [accountId, DELETED_ACTOR, DELETED_NAME],
          );
          await client.query(
            "UPDATE person_removals SET actor_id=$2 WHERE actor_id=$1",
            [accountId, DELETED_ACTOR],
          );
          await client.query(
            "UPDATE research_suggestions SET created_by=$2 WHERE created_by=$1",
            [accountId, DELETED_ACTOR],
          );
          await client.query(
            "UPDATE research_suggestions SET reviewed_by=$2 WHERE reviewed_by=$1",
            [accountId, DELETED_ACTOR],
          );
          await client.query(
            "UPDATE ai_usage SET user_id=$2 WHERE user_id=$1",
            [accountId, DELETED_ACTOR],
          );
          await client.query("DELETE FROM ai_chats WHERE user_id=$1", [
            accountId,
          ]);
          await client.query("DELETE FROM workflow_stages WHERE actor_id=$1", [
            accountId,
          ]);
          await client.query(
            "DELETE FROM document_upload_requests WHERE user_id=$1",
            [accountId],
          );
          await client.query(
            "DELETE FROM media_upload_grants WHERE user_id=$1",
            [accountId],
          );
          await client.query(
            "DELETE FROM user_tree_preferences WHERE user_id=$1",
            [accountId],
          );
          await client.query(
            "UPDATE share_links SET revoked_at=COALESCE(revoked_at,$2),created_by=$3,created_name=$4 WHERE created_by=$1",
            [accountId, new Date().toISOString(), DELETED_ACTOR, DELETED_NAME],
          );
          await client.query(
            "UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,$2),created_by=$3 WHERE created_by=$1",
            [accountId, new Date().toISOString(), DELETED_ACTOR],
          );
          await client.query(
            "UPDATE face_descriptors SET created_by=NULL WHERE created_by=$1",
            [accountId],
          );
          await client.query(
            "UPDATE relations SET created_by=NULL WHERE created_by=$1",
            [accountId],
          );
          await client.query(
            `UPDATE discovery_match_requests SET
              requested_by=CASE WHEN requested_by=$1 THEN $2 ELSE requested_by END,
              responded_by=CASE WHEN responded_by=$1 THEN $2 ELSE responded_by END,
              revoked_by=CASE WHEN revoked_by=$1 THEN $2 ELSE revoked_by END
             WHERE requested_by=$1 OR responded_by=$1 OR revoked_by=$1`,
            [accountId, DELETED_ACTOR],
          );
          await client.query(
            "DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id=$2",
            [archiveId, accountId],
          );
        }

        await client.query(
          "INSERT INTO deleted_account_tombstones(id) VALUES($1) ON CONFLICT(id) DO NOTHING",
          [accountId],
        );
        const deleted = await client.query("DELETE FROM accounts WHERE id=$1", [
          accountId,
        ]);
        if (deleted.rowCount !== 1)
          throw new AccountDeletionConflict("Аккаунт уже удалён");
        return { deleted: true, sharedArchives: memberships.rowCount || 0 };
      });
    },
  };
}
