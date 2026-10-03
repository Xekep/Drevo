import type { StoreDatabase } from "./store-database.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { readArchive } from "./database.ts";
import { commentFilesFromJson } from "./discussion-attachments.ts";
import type { CommentAttachmentFile } from "../shared/person-discussion.ts";
import { accountAiAccess } from "./account-ai-access.ts";
import { aiChatAccessScope } from "./ai-chat-access-scope.ts";

type AccessScope = {
  archiveId: string;
  approved: boolean;
  role: string;
  treeAccess: string;
  personId: string | null;
  revision: number;
  aiChatsExported: boolean;
};

function scopesStillVisible(
  scopes: AccessScope[],
  rows: Array<Record<string, unknown>>,
) {
  const current = new Map(rows.map((row) => [String(row.archive_id), row]));
  return scopes.every((scope) => {
    const row = current.get(scope.archiveId);
    return row?.approved === scope.approved && row.role === scope.role &&
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
            "SELECT provider,subject FROM account_identities WHERE account_id=? ORDER BY provider",
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
        const accessScopes: AccessScope[] = [];
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
          let ownAiChats: Array<{
            id: string;
            createdAt: string;
            updatedAt: string;
            messages: Array<{ role: string; content: string; createdAt: string }>;
          }> | null = null;
          const archive = await db.prepare("", "SELECT revision FROM archives WHERE id=?")
            .get(String(membership.archive_id));
          if (!archive) return null;
          // The download also includes title, role and preferences for an
          // unapproved membership. Recheck every represented archive, even
          // when it has no readable comments.
          const accessScope: AccessScope = {
            archiveId: String(membership.archive_id),
            approved: membership.approved === true,
            role: String(membership.role),
            treeAccess: String(membership.tree_access),
            personId: membership.person_id == null
              ? null
              : String(membership.person_id),
            revision: Number(archive.revision),
            aiChatsExported: false,
          };
          accessScopes.push(accessScope);
          if (membership.approved === true) {
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
            const family = isScopedUser(user)
              ? (await readArchive(db)).family
              : undefined;
            const visible = family ? visiblePersonIds(family, user) : null;
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
            if (await accountAiAccess(db, accountId)) {
              const scope = aiChatAccessScope(user, family);
              const chatRows = await db.prepare("", `SELECT c.id,c.created_at,c.updated_at,
                m.role,m.content,m.created_at AS message_created_at,m.id AS message_id
                FROM ai_chats c LEFT JOIN ai_chat_messages m
                  ON m.archive_id=c.archive_id AND m.chat_id=c.id
                 AND (m.data->>'hidden') IS DISTINCT FROM 'true'
                WHERE c.user_id=? AND c.access_scope=?
                ORDER BY c.created_at,c.id,m.id`).all(accountId, scope);
              ownAiChats = [];
              for (const row of chatRows) {
                if (ownAiChats.at(-1)?.id !== String(row.id))
                  ownAiChats.push({
                    id: String(row.id),
                    createdAt: String(row.created_at),
                    updatedAt: String(row.updated_at),
                    messages: [],
                  });
                if (row.message_id != null)
                  ownAiChats.at(-1)!.messages.push({
                    role: String(row.role),
                    content: String(row.content),
                    createdAt: String(row.message_created_at),
                  });
              }
              accessScope.aiChatsExported = ownAiChats.length > 0;
            }
          }
          archives.push({
            id: String(membership.archive_id),
            title: String(membership.title),
            role: String(membership.role),
            treeAccess: String(membership.tree_access),
            approved: membership.approved === true,
            owned: membership.owned === true,
            ownComments,
            ownAiChats,
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
        return { accessScopes, download: {
          format: "drevo-account-data",
          version: 4,
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
            identities: methods.map((row) => ({
              provider: String(row.provider),
              subject: String(row.subject),
            })),
            verifiedEmail: email ? String(email.email) : null,
          },
          archives,
        } };
      }, true);
    },
    /** Recheck membership and graph revision before sending the snapshot.
     * A graph edit can narrow scoped visibility without changing membership. */
    async canDeliver(accountId: string, scopes: AccessScope[]) {
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
    /** Lock every scope represented in the prepared download, then the
     * session and membership rows through the response handoff. Archive
     * mutations take the archive lock first, so revocation and graph edits
     * either finish before this check or wait until the response is handed
     * to the HTTP server. The caller prepares JSON before entering here. */
    async deliverWithCurrentSession(
      accountId: string,
      tokenHash: string,
      scopes: AccessScope[],
      deliver: () => void | Promise<void>,
    ): Promise<"sent" | "session-expired" | "access-changed" | "access-busy"> {
      if (db.kind !== "postgres" || !db.postgresTransaction)
        return "access-changed";
      // Account deletion locks session before archive; normal archive writes
      // lock archive before session. Never wait while holding either lock.
      // Retry only after postgresTransaction has rolled back and released all
      // locks, then ask the caller to retry if another operation stays busy.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await db.postgresTransaction(async (client) => {
            await client.query("SELECT set_config('drevo.account_id',$1,true)", [accountId]);
            const archiveIds = [...new Set(scopes.map((scope) => scope.archiveId))].sort();
            for (const archiveId of archiveIds) {
              await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
              const archive = await client.query(
                "SELECT id FROM archives WHERE id=$1 FOR SHARE NOWAIT", [archiveId],
              );
              if (!archive.rowCount) return "access-changed";
            }
            const session = await client.query(
              `SELECT expires_at FROM account_sessions
               WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [tokenHash, accountId],
            );
            if (!session.rowCount || Number(session.rows[0].expires_at) <= Date.now())
              return "session-expired";
            if (!(await client.query("SELECT 1 FROM accounts WHERE id=$1", [accountId])).rowCount)
              return "session-expired";
            const membershipRows: Array<Record<string, unknown>> = [];
            for (const archiveId of archiveIds) {
              await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
              const membership = await client.query(
                `SELECT m.archive_id,m.role,m.tree_access,m.person_id,m.approved,a.revision
                 FROM archive_memberships m JOIN archives a ON a.id=m.archive_id
                 WHERE m.user_id=$1 AND m.archive_id=$2
                 FOR SHARE OF m,a NOWAIT`,
                [accountId, archiveId],
              );
              membershipRows.push(...membership.rows);
            }
            if (!scopesStillVisible(scopes, membershipRows))
              return "access-changed";
            for (const scope of scopes.filter((item) => item.aiChatsExported)) {
              await client.query("SELECT set_config('drevo.archive_id',$1,true)", [scope.archiveId]);
              const tier = await client.query(
                `SELECT viewer.full_access AS viewer_full,
                        owner_tier.full_access AS owner_full
                 FROM account_tiers viewer
                 JOIN archive_owners owner ON owner.archive_id=$2
                 JOIN account_tiers owner_tier ON owner_tier.account_id=owner.user_id
                 WHERE viewer.account_id=$1
                 FOR SHARE OF viewer,owner_tier NOWAIT`,
                [accountId, scope.archiveId],
              );
              if (tier.rows[0]?.viewer_full !== true ||
                  tier.rows[0]?.owner_full !== true)
                return "access-changed";
            }
            await deliver();
            return "sent";
          });
        } catch (error) {
          if ((error as { code?: string }).code !== "55P03") throw error;
          if (attempt === 2) return "access-busy";
          await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
        }
      }
      return "access-busy";
    },
  };
}
