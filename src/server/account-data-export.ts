import type { StoreDatabase } from "./store-database.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { readArchive } from "./database.ts";
import { commentFilesFromJson } from "./discussion-attachments.ts";
import type { CommentAttachmentFile } from "../shared/person-discussion.ts";

type CommentScope = {
  archiveId: string;
  role: string;
  treeAccess: string;
  personId: string | null;
  revision: number;
};

function scopesStillVisible(
  scopes: CommentScope[],
  rows: Array<Record<string, unknown>>,
) {
  const current = new Map(rows.map((row) => [String(row.archive_id), row]));
  return scopes.every((scope) => {
    const row = current.get(scope.archiveId);
    return row?.approved === true && row.role === scope.role &&
      row.tree_access === scope.treeAccess &&
      (row.person_id == null ? null : String(row.person_id)) === scope.personId &&
      Number(row.revision) === scope.revision;
  });
}

/** A consistent snapshot of the account's own profile and archive access. */
export function accountDataExport(db: StoreDatabase) {
  return {
    async read(accountId: string) {
      if (db.kind !== "postgres") return null;
      return await db.transaction(async () => {
        const profile = await db
          .prepare(
            "",
            `SELECT a.id,a.name,a.created_at,a.last_visit_at,t.full_access
             FROM accounts a JOIN account_tiers t ON t.account_id=a.id
             WHERE a.id=?`,
          )
          .get(accountId);
        if (!profile) return null;
        await db
          .prepare("", "SELECT set_config('drevo.account_id',?,true)")
          .get(accountId);
        const methods = await db
          .prepare(
            "",
            "SELECT provider FROM account_identities WHERE account_id=? ORDER BY provider",
          )
          .all(accountId);
        const email = await db
          .prepare(
            "",
            "SELECT email FROM account_email_credentials WHERE account_id=?",
          )
          .get(accountId);
        const memberships = await db
          .prepare(
            "",
            `SELECT m.archive_id,a.title,m.role,m.approved,m.tree_access,m.person_id,
                    (o.user_id IS NOT NULL) AS owned
             FROM archive_memberships m
             JOIN archives a ON a.id=m.archive_id
             LEFT JOIN archive_owners o
               ON o.archive_id=m.archive_id AND o.user_id=m.user_id
             WHERE m.user_id=?
             ORDER BY lower(a.title),a.id`,
          )
          .all(accountId);
        const archives = [];
        const commentScopes: CommentScope[] = [];
        for (const membership of memberships) {
          await db
            .prepare("", "SELECT set_config('drevo.archive_id',?,true)")
            .get(String(membership.archive_id));
          const saved = await db
            .prepare(
              "",
              `SELECT reverse_timeline,card_variant,color_scheme,generation_limits
               FROM user_tree_preferences
               WHERE archive_id=? AND user_id=?`,
            )
            .get(String(membership.archive_id), accountId);
          // Export only current text authored by this account in a tree it can
          // still read. A scoped member must not regain hidden branches through
          // the global account download.
          let ownComments: Array<{
            id: string;
            personId: string;
            text: string;
            createdAt: string;
            editedAt: string | null;
            attachments: CommentAttachmentFile[];
          }> | null = null;
          if (membership.approved === true) {
            const archive = await db.prepare("", "SELECT revision FROM archives WHERE id=?")
              .get(String(membership.archive_id));
            if (!archive) return null;
            commentScopes.push({
              archiveId: String(membership.archive_id),
              role: String(membership.role),
              treeAccess: String(membership.tree_access),
              personId: membership.person_id == null
                ? null
                : String(membership.person_id),
              revision: Number(archive.revision),
            });
            const user: ArchiveUser = {
              id: accountId,
              name: String(profile.name),
              createdAt: String(profile.created_at),
              role: String(membership.role) as ArchiveUser["role"],
              approved: true,
              treeAccess: String(membership.tree_access) as ArchiveUser["treeAccess"],
              ...(membership.person_id
                ? { personId: String(membership.person_id) }
                : {}),
            };
            const visible = isScopedUser(user)
              ? visiblePersonIds((await readArchive(db)).family, user)
              : null;
            const comments = await db
              .prepare(
                "",
                `SELECT c.id,c.person_id,c.text,c.created_ms,c.updated_ms,c.attachments
                 FROM person_comments c JOIN people p
                   ON p.archive_id=c.archive_id AND p.id=c.person_id
                 WHERE c.archive_id=? AND c.author_id=? ORDER BY c.id`,
              )
              .all(String(membership.archive_id), accountId);
            ownComments = comments
              .filter((row) => !visible || visible.has(String(row.person_id)))
              .map((row) => ({
                id: String(row.id),
                personId: String(row.person_id),
                text: String(row.text),
                attachments: commentFilesFromJson(row.attachments),
                createdAt: new Date(Number(row.created_ms)).toISOString(),
                editedAt:
                  row.updated_ms == null
                    ? null
                    : new Date(Number(row.updated_ms)).toISOString(),
              }));
          }
          archives.push({
            id: String(membership.archive_id),
            title: String(membership.title),
            role: String(membership.role),
            treeAccess: String(membership.tree_access),
            approved: membership.approved === true,
            owned: membership.owned === true,
            ownComments,
            preferences: saved
              ? {
                  reverseTimeline: !!saved.reverse_timeline,
                  cardVariant: String(saved.card_variant),
                  colorScheme: String(saved.color_scheme),
                  generationLimits: saved.generation_limits
                    ? JSON.parse(String(saved.generation_limits))
                    : null,
                }
              : null,
          });
        }
        return { commentScopes, download: {
          format: "drevo-account-data",
          version: 2,
          exportedAt: new Date().toISOString(),
          account: {
            id: String(profile.id),
            name: String(profile.name),
            createdAt: String(profile.created_at),
            lastVisitAt: profile.last_visit_at
              ? String(profile.last_visit_at)
              : null,
            fullAccess: profile.full_access === true,
            providers: methods
              .map((row) => String(row.provider))
              .filter((provider) => ["email", "vk", "yandex"].includes(provider)),
            verifiedEmail: email ? String(email.email) : null,
          },
          archives,
        } };
      }, true);
    },
    /** Recheck membership and graph revision before sending the snapshot.
     * A graph edit can narrow scoped visibility without changing membership. */
    async canDeliver(accountId: string, scopes: CommentScope[]) {
      if (db.kind !== "postgres") return false;
      return await db.transaction(async () => {
        await db.prepare("", "SELECT set_config('drevo.account_id',?,true)")
          .get(accountId);
        if (!(await db.prepare("", "SELECT 1 FROM accounts WHERE id=?")
          .get(accountId))) return false;
        const rows = await db.prepare("", `SELECT m.archive_id,m.role,m.tree_access,
          m.person_id,m.approved,a.revision FROM archive_memberships m
          JOIN archives a ON a.id=m.archive_id WHERE m.user_id=?`).all(accountId);
        return scopesStillVisible(scopes, rows);
      }, true);
    },
    /** Keep the caller's session locked through the final permission check and
     * response handoff. A completed logout blocks delivery; a later logout
     * waits until the response is handed to the HTTP server. */
    async deliverWithCurrentSession(
      accountId: string,
      tokenHash: string,
      scopes: CommentScope[],
      deliver: () => void | Promise<void>,
    ): Promise<"sent" | "session-expired" | "access-changed"> {
      if (db.kind !== "postgres" || !db.postgresTransaction)
        return "access-changed";
      return await db.postgresTransaction(async (client) => {
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [accountId]);
        const session = await client.query(
          `SELECT expires_at FROM account_sessions
           WHERE token_hash=$1 AND user_id=$2 FOR SHARE`,
          [tokenHash, accountId],
        );
        if (!session.rowCount || Number(session.rows[0].expires_at) <= Date.now())
          return "session-expired";
        if (!(await client.query("SELECT 1 FROM accounts WHERE id=$1", [accountId])).rowCount)
          return "session-expired";
        const memberships = await client.query(
          `SELECT m.archive_id,m.role,m.tree_access,m.person_id,m.approved,a.revision
           FROM archive_memberships m JOIN archives a ON a.id=m.archive_id
           WHERE m.user_id=$1`,
          [accountId],
        );
        if (!scopesStillVisible(scopes, memberships.rows))
          return "access-changed";
        await deliver();
        return "sent";
      });
    },
  };
}
