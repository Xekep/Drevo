import type { StoreDatabase } from "./store-database.ts";

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
      const redaction = await client.query(
        "SELECT COALESCE(has_function_privilege(current_user,to_regprocedure('public.runtime_redact_deleted_account_comments(text)')::oid,'EXECUTE'),false) AS allowed",
      );
      return {
        name: String(account.rows[0].name),
        ownedArchives: Number(owned.rows[0].total),
        sharedArchives: Number(memberships.rows[0].total),
        canRedactComments: redaction.rows[0]?.allowed === true,
      };
    });
  }

  return {
    available,
    preview: (accountId: string) => summary(accountId, false),
    async remove(
      accountId: string,
      confirmation: { name: string; leaveSharedArchives: boolean; redactComments?: boolean },
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

        const cleanupFunction = await client.query(
          "SELECT to_regprocedure('public.runtime_anonymize_deleted_account_history(text)') AS installed",
        );
        if (!cleanupFunction.rows[0]?.installed)
          throw new AccountDeletionConflict(
            "Удаление аккаунта пока недоступно: требуется настройка обезличивания истории",
          );
        // A pre-058 privileged function leaves live union createdBy IDs behind.
        // Fail before writing the deletion tombstone unless the upgraded
        // SECURITY DEFINER entrypoint and its union helper are installed.
        const unionCleanup = await client.query(`SELECT EXISTS (
          SELECT 1 FROM pg_proc entrypoint
          JOIN pg_roles owner_role ON owner_role.oid=entrypoint.proowner
          JOIN pg_proc union_cleanup ON union_cleanup.oid=
            to_regprocedure('public.runtime_anonymize_deleted_account_unions(text)')
          JOIN pg_roles union_owner ON union_owner.oid=union_cleanup.proowner
          WHERE entrypoint.oid=to_regprocedure('public.runtime_anonymize_deleted_account_history(text)')
            AND entrypoint.prosecdef AND union_cleanup.prosecdef
            AND (owner_role.rolsuper OR owner_role.rolbypassrls)
            AND (union_owner.rolsuper OR union_owner.rolbypassrls)
            AND has_function_privilege(current_user,entrypoint.oid,'EXECUTE')
            AND position('PERFORM public.runtime_anonymize_deleted_account_unions(account_id)'
              IN pg_get_functiondef(entrypoint.oid))>0
        ) AS installed`);
        if (unionCleanup.rows[0]?.installed !== true)
          throw new AccountDeletionConflict(
            "Удаление аккаунта пока недоступно: администратор должен установить миграцию 058 обезличивания авторства союзов",
          );
        if (confirmation.redactComments) {
          const redactionFunction = await client.query(
            "SELECT COALESCE(has_function_privilege(current_user,to_regprocedure('public.runtime_redact_deleted_account_comments(text)')::oid,'EXECUTE'),false) AS allowed",
          );
          if (redactionFunction.rows[0]?.allowed !== true)
            throw new AccountDeletionConflict(
              "Удаление текстов комментариев пока недоступно: администратор должен обновить настройку PostgreSQL",
            );
        }
        // Comment writes lock the archive first, then the author. Take these
        // locks in the same order before the author advisory lock below.
        for (const { archive_id: archiveId } of memberships.rows) {
          await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
          await client.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE", [archiveId]);
        }
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('drevo-comment:' || $1,0))",
          [accountId],
        );
        await client.query(
          "INSERT INTO deleted_account_tombstones(id,redact_comments) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET redact_comments=excluded.redact_comments",
          [accountId, confirmation.redactComments === true],
        );
        await client.query("SET LOCAL statement_timeout='5min'");
        if (confirmation.redactComments)
          await client.query("SELECT public.runtime_redact_deleted_account_comments($1)", [accountId]);
        // Installed by a PostgreSQL administrator. It changes only attribution
        // matching this authenticated account, including archives left earlier.
        await client.query(
          "SELECT public.runtime_anonymize_deleted_account_history($1)",
          [accountId],
        );

        for (const { archive_id: archiveId } of memberships.rows) {
          await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
            archiveId,
          ]);
          await client.query(
            "DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id=$2",
            [archiveId, accountId],
          );
        }

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
