import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { accountProfileFromRow, type createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { archiveUserFromRow } from "./users.ts";
import { canEditArchive } from "../domain/access.ts";

/** Public session status; authenticated fields are assembled on demand. */
export function sessionHttp(
  auth: Awaited<ReturnType<typeof createAuth>>,
  db: StoreDatabase,
  providers: { yandex: boolean; vk: () => Promise<boolean>; email: boolean },
  beforeDelivery?: () => Promise<void>,
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/session" || req.method !== "GET") return false;
    const enabled = {
      local: auth.local,
      yandex: providers.yandex,
      vk: await providers.vk(),
      email: providers.email,
    };
    const guest = { ...enabled, canEdit: false, account: null, user: null };
    const localBody = async () => {
      const user = await auth.currentUser(req);
      return {
        ...enabled,
        canEdit: await auth.canEdit(req),
        account: await auth.accountProfile(req),
        user: user ? { ...user, platformAdmin: await auth.isPlatformAdmin(req) } : null,
      };
    };
    const send = async (status: number, value: unknown, bounded = false) => {
      const timer = bounded
        ? setTimeout(() => res.destroy(new Error("Session delivery timed out")), 4_000)
        : null;
      timer?.unref();
      try {
        const delivered = bounded ? finished(res, { cleanup: true }) : null;
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(value));
        if (delivered) await delivered;
      } finally {
        if (timer) clearTimeout(timer);
      }
      return true;
    };
    if (auth.local || db.kind !== "postgres" || !db.postgresTransaction)
      return send(200, await localBody());
    await beforeDelivery?.();
    const session = await auth.accountSession(req);
    if (!session) return send(200, guest);
    try {
      return await db.postgresTransaction(async (client) => {
        // Account/session rows are locked in the same order as account deletion.
        const account = await client.query(
          "SELECT id,name,created_at,last_visit_at FROM accounts WHERE id=$1 FOR SHARE NOWAIT",
          [session.accountId]);
        if (!account.rowCount) return send(200, guest);
        const active = await client.query<{ expires_at: string }>(
          `SELECT expires_at FROM account_sessions
           WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
          [session.tokenHash, session.accountId]);
        if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now())
          return send(200, guest);
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [session.accountId]);
        const membership = await client.query(
          "SELECT role,approved,person_id,tree_access FROM archive_memberships WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT",
          [db.archiveId, session.accountId]);
        const tier = await client.query(
          "SELECT full_access FROM account_tiers WHERE account_id=$1 FOR SHARE NOWAIT",
          [session.accountId]);
        const platformAdmin = await client.query(
          "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
          [session.accountId]);
        const platformResearcher = await client.query(
          "SELECT account_id FROM platform_researchers WHERE account_id=$1 FOR SHARE NOWAIT",
          [session.accountId]);
        const owner = await client.query(
          "SELECT user_id FROM archive_owners WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT",
          [db.archiveId, session.accountId]);
        const identities = await client.query<{ provider: string }>(
          "SELECT provider FROM account_identities WHERE account_id=$1 ORDER BY provider FOR SHARE NOWAIT",
          [session.accountId]);
        const accountRow = account.rows[0];
        const user = membership.rows[0]
          ? archiveUserFromRow({ ...accountRow, ...membership.rows[0],
              full_access: tier.rows[0]?.full_access,
              tree_role: membership.rows[0].role,
              global_role: platformAdmin.rowCount ? "admin" :
                platformResearcher.rowCount ? "researcher" : null,
              archive_owner: !!owner.rowCount })
          : null;
        const providers = identities.rows.map((row) => row.provider);
        const profile = accountProfileFromRow({ ...accountRow,
          full_access: tier.rows[0]?.full_access,
          provider: providers[0], providers });
        return send(200, { ...enabled,
          canEdit: canEditArchive(user),
          account: { ...profile,
            globalRole: platformAdmin.rowCount ? "admin" :
              platformResearcher.rowCount ? "researcher" : null },
          user: user ? { ...user,
            platformAdmin: user.approved === true && (platformAdmin.rowCount ?? 0) > 0 } : null,
        }, true);
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy(error as Error);
        return true;
      }
      if ((error as { code?: string }).code === "55P03")
        return send(409, { error: "Данные сеанса изменяются. Повторите запрос" });
      throw error;
    }
  };
}
