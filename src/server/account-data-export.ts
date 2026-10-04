import type { StoreDatabase } from "./store-database.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { readArchive } from "./database.ts";
import { commentFilesFromJson } from "./discussion-attachments.ts";
import type { CommentAttachmentFile } from "../shared/person-discussion.ts";
import { accountAiAccess } from "./account-ai-access.ts";
import { aiChatAccessScope } from "./ai-chat-access-scope.ts";
import {
  AccountAttachmentExportTooLarge,
  AccountAttachmentExportMissing,
  MAX_ACCOUNT_ATTACHMENT_FILES,
  aiFilesFromJson,
  type OwnAiAttachment,
} from "./account-attachment-export.ts";
import type { PoolClient } from "pg";

const MAX_EXPORTED_AI_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_EXPORTED_AI_MESSAGES = 50_000;
export const MAX_ACCOUNT_JSON_BYTES = 24 * 1024 * 1024;
const MAX_EXPORTED_COMMENTS = 10_000;
const MAX_EXPORTED_COMMENT_PREFLIGHT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORTED_IDENTITIES = 64;
const MAX_EXPORTED_ARCHIVES = 1_000;
const MAX_EXPORTED_METADATA_RAW_BYTES = 2 * 1024 * 1024;
const MAX_SCOPED_GRAPH_ROWS = 20_000;
const MAX_SCOPED_GRAPH_BYTES = 16 * 1024 * 1024;

type AccessScope = {
  archiveId: string;
  approved: boolean;
  role: string;
  treeAccess: string;
  personId: string | null;
  revision: number;
  owned: boolean;
  aiChatsExported: boolean;
};

export class AccountAiHistoryTooLarge extends Error {
  readonly accessScopes: AccessScope[];
  constructor(accessScopes: AccessScope[]) {
    super("AI chat history exceeds the JSON export limit");
    this.accessScopes = accessScopes;
  }
}

export class AccountJsonTooLarge extends Error {
  readonly accessScopes: AccessScope[];
  readonly membershipBoundsExceeded: boolean;
  constructor(accessScopes: AccessScope[], membershipBoundsExceeded = false) {
    super("Account JSON export exceeds the current limit");
    this.accessScopes = accessScopes;
    this.membershipBoundsExceeded = membershipBoundsExceeded;
  }
}

/** For a generic over-limit refusal, recheck the current count/size without
 * returning an unbounded row array to Node. A completed removal that takes
 * the account back under the limit makes the prepared refusal stale. The
 * account-wide RLS read policy applies here; row locks would instead use the
 * single-archive write policy and miss memberships in other trees. */
export async function accountMembershipsStillOverExportLimit(
  client: PoolClient,
  accountId: string,
) {
  const result = await client.query(`SELECT count(*)::integer AS total,
      COALESCE(sum(octet_length(m.archive_id)+octet_length(a.title)
        +octet_length(m.role)+octet_length(m.tree_access)
        +COALESCE(octet_length(m.person_id),0)+512),0) AS bytes
    FROM archive_memberships m JOIN archives a ON a.id=m.archive_id
    WHERE m.user_id=$1`, [accountId]);
  return Number(result.rows[0]?.total) > MAX_EXPORTED_ARCHIVES ||
    Number(result.rows[0]?.bytes) > MAX_EXPORTED_METADATA_RAW_BYTES;
}

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
      Number(row.revision) === scope.revision && row.owned === scope.owned;
  });
}

/** A consistent snapshot of the account's own profile and archive access. */
export function accountDataExport(db: StoreDatabase) {
  return {
    async read(accountId: string, includeAiChats = true, includeAiAttachments = false) {
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
        const email = await db
          .prepare(
            "",
            "SELECT email FROM account_email_credentials WHERE account_id=?",
          )
          .get(accountId);
        // Metadata is small in normal accounts, but neither identities nor
        // memberships have a lifetime count limit. Reject an oversized JSON
        // without reading the much larger comment and AI collections.
        const metadata = includeAiChats ? await db.prepare("", `
          SELECT (SELECT count(*) FROM account_identities WHERE account_id=?) AS identities,
            (SELECT COALESCE(sum(octet_length(provider)+octet_length(subject)+96),0)
               FROM account_identities WHERE account_id=?) AS identity_bytes,
            (SELECT count(*) FROM archive_memberships WHERE user_id=?) AS memberships,
            (SELECT COALESCE(sum(octet_length(m.archive_id)+octet_length(a.title)
                +octet_length(m.role)+octet_length(m.tree_access)
                +COALESCE(octet_length(m.person_id),0)+512),0)
               FROM archive_memberships m JOIN archives a ON a.id=m.archive_id
              WHERE m.user_id=?) AS membership_bytes`).get(
                accountId, accountId, accountId, accountId)
          : null;
        const membershipBounds = metadata == null
          ? await db.prepare("", `SELECT count(*) AS memberships,
              COALESCE(sum(octet_length(m.archive_id)+octet_length(a.title)
                +octet_length(m.role)+octet_length(m.tree_access)
                +COALESCE(octet_length(m.person_id),0)+512),0) AS membership_bytes
              FROM archive_memberships m JOIN archives a ON a.id=m.archive_id
              WHERE m.user_id=?`).get(accountId)
          : metadata;
        // No archive data is serialized for this refusal. In particular, do
        // not load every membership merely to construct an unbounded set of
        // per-archive delivery scopes for an already oversized account.
        if (Number(membershipBounds?.memberships) > MAX_EXPORTED_ARCHIVES ||
            Number(membershipBounds?.membership_bytes) > MAX_EXPORTED_METADATA_RAW_BYTES)
          throw new AccountJsonTooLarge([], true);
        let metadataRawBytes = metadata == null ? 0 :
          Number(metadata.identity_bytes) + Number(metadata.membership_bytes) +
          Buffer.byteLength(String(profile.id)) + Buffer.byteLength(String(profile.name)) +
          Buffer.byteLength(String(email?.email ?? "")) + 512;
        let jsonTooLarge = metadata != null &&
          (Number(metadata.identities) > MAX_EXPORTED_IDENTITIES ||
           Number(metadata.memberships) > MAX_EXPORTED_ARCHIVES ||
           metadataRawBytes > MAX_EXPORTED_METADATA_RAW_BYTES);
        const methods = jsonTooLarge ? [] : await db
          .prepare(
            "",
            "SELECT provider,subject FROM account_identities WHERE account_id=? ORDER BY provider",
          )
          .all(accountId);
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
        const aiAttachments: OwnAiAttachment[] = [];
        let aiAttachmentError: "too-large" | "missing" | null = null;
        let aiMessageBytes = BigInt(0);
        let aiMessageCount = BigInt(0);
        let aiHistoryTooLarge = false;
        let commentCount = BigInt(0);
        let commentPreflightBytes = BigInt(0);
        let scopedGraphRows = 0;
        let scopedGraphBytes = 0;
        for (const membership of memberships) {
          await db
            .prepare("", "SELECT set_config('drevo.archive_id',?,true)")
            .get(String(membership.archive_id));
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
            messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
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
            owned: membership.owned === true,
            aiChatsExported: false,
          };
          accessScopes.push(accessScope);
          if (jsonTooLarge || aiHistoryTooLarge) continue;
          const saved = await db
            .prepare(
              "",
              `SELECT reverse_timeline,card_variant,color_scheme,generation_limits
               FROM user_tree_preferences
               WHERE archive_id=? AND user_id=?`,
            )
            .get(String(membership.archive_id), accountId);
          if (includeAiChats && saved) {
            metadataRawBytes += Buffer.byteLength(String(saved.generation_limits ?? "")) +
              Buffer.byteLength(String(saved.card_variant)) +
              Buffer.byteLength(String(saved.color_scheme)) + 64;
            if (metadataRawBytes > MAX_EXPORTED_METADATA_RAW_BYTES) {
              jsonTooLarge = true;
              continue;
            }
          }
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
              ? await (async () => {
                // readArchive materializes the entire graph and may hydrate
                // citations from the source catalog. Bound the combined rows
                // and raw JSON before that read. The final revision check
                // still protects the visibility snapshot at delivery.
                const graph = await db.prepare("", `SELECT
                    (SELECT count(*) FROM people) +
                    (SELECT count(*) FROM relations) +
                    (SELECT count(*) FROM photos) +
                    (SELECT count(*) FROM photo_tags) +
                    (SELECT count(*) FROM family_unions) +
                    (SELECT count(*) FROM source_catalog) AS rows,
                    (SELECT octet_length(description) FROM archives
                      WHERE id=current_setting('drevo.archive_id',true)) +
                    (SELECT COALESCE(sum(octet_length(data::text)),0) FROM people) +
                    (SELECT COALESCE(sum(octet_length(note)+
                      COALESCE(octet_length(sources::text),0)+
                      octet_length(id)+octet_length(source)+octet_length(target)+
                      COALESCE(octet_length(created_by),0)+256),0) FROM relations) +
                    (SELECT COALESCE(sum(octet_length(data::text)),0) FROM photos) +
                    (SELECT COALESCE(sum(octet_length(data::text)),0) FROM photo_tags) +
                    (SELECT COALESCE(sum(octet_length(data::text)),0) FROM family_unions) +
                    (SELECT COALESCE(sum(octet_length(data::text)),0) FROM source_catalog)
                      AS bytes`).get();
                scopedGraphRows += Number(graph?.rows);
                scopedGraphBytes += Number(graph?.bytes);
                if (scopedGraphRows > MAX_SCOPED_GRAPH_ROWS ||
                    scopedGraphBytes > MAX_SCOPED_GRAPH_BYTES)
                  throw new AccountJsonTooLarge(accessScopes);
                return (await readArchive(db)).family;
              })()
              : undefined;
            const visible = family ? visiblePersonIds(family, user) : null;
            const personFilter = visible
              ? " AND c.person_id=ANY(ARRAY(SELECT jsonb_array_elements_text(?::jsonb)))"
              : "";
            const commentArgs = visible
              ? [String(membership.archive_id), accountId, JSON.stringify([...visible])]
              : [String(membership.archive_id), accountId];
            if (includeAiChats) {
              // Include attachment metadata and per-row overhead, but do not
              // treat PostgreSQL bytes as the escaped JSON response size.
              const size = await db.prepare("", `SELECT count(*) AS comments,
                  COALESCE(sum(octet_length(c.text)
                    +COALESCE(octet_length(c.attachments::text),0)
                    +octet_length(c.person_id)+256),0) AS bytes
                FROM person_comments c JOIN people p
                  ON p.archive_id=c.archive_id AND p.id=c.person_id
                WHERE c.archive_id=? AND c.author_id=?${personFilter}`)
                .get(...commentArgs);
              commentCount += BigInt(String(size?.comments ?? 0));
              commentPreflightBytes += BigInt(String(size?.bytes ?? 0));
              if (commentCount > BigInt(MAX_EXPORTED_COMMENTS) ||
                  commentPreflightBytes > BigInt(MAX_EXPORTED_COMMENT_PREFLIGHT_BYTES)) {
                jsonTooLarge = true;
                continue;
              }
            }
            const comments = await db
              .prepare(
                "",
                `SELECT c.id,c.person_id,c.text,c.created_ms,c.updated_ms,c.attachments
                 FROM person_comments c JOIN people p
                   ON p.archive_id=c.archive_id AND p.id=c.person_id
                 WHERE c.archive_id=? AND c.author_id=?${personFilter} ORDER BY c.id`,
              )
              .all(...commentArgs);
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
            if ((includeAiChats || includeAiAttachments) &&
                await accountAiAccess(db, accountId)) {
              const scope = aiChatAccessScope(user, family);
              if (includeAiAttachments && !aiAttachmentError) {
                try {
                  // Fetch only visible attachment metadata, not every message or
                  // its text. The extra row detects an oversized bundle before
                  // materializing a potentially unbounded inventory.
                  const rows = await db.prepare("", `SELECT c.id AS chat_id,
                      m.id AS message_id,m.data->'attachments' AS attachments
                    FROM ai_chats c JOIN ai_chat_messages m
                      ON m.archive_id=c.archive_id AND m.chat_id=c.id
                    WHERE c.user_id=? AND c.access_scope=?
                      AND (m.data->>'hidden') IS DISTINCT FROM 'true'
                      AND m.data->'attachments' IS NOT NULL
                      AND CASE WHEN jsonb_typeof(m.data->'attachments')='array'
                        THEN jsonb_array_length(m.data->'attachments')>0 ELSE true END
                    ORDER BY c.id,m.id LIMIT ?`).all(
                      accountId, scope, MAX_ACCOUNT_ATTACHMENT_FILES + 1);
                  if (rows.length > MAX_ACCOUNT_ATTACHMENT_FILES)
                    throw new AccountAttachmentExportTooLarge("Too many AI attachment messages");
                  for (const row of rows) {
                    const chatId = String(row.chat_id);
                    for (const file of aiFilesFromJson(row.attachments, chatId)) {
                      aiAttachments.push({
                        archiveId: String(membership.archive_id),
                        chatId,
                        messageId: String(row.message_id),
                        accessScope: scope,
                        file,
                      });
                      if (aiAttachments.length > MAX_ACCOUNT_ATTACHMENT_FILES)
                        throw new AccountAttachmentExportTooLarge("Too many AI originals");
                    }
                  }
                  if (rows.length > 0) accessScope.aiChatsExported = true;
                } catch (error) {
                  if (error instanceof AccountAttachmentExportTooLarge)
                    aiAttachmentError = "too-large";
                  else if (error instanceof AccountAttachmentExportMissing)
                    aiAttachmentError = "missing";
                  else throw error;
                  // The error itself may disclose AI history size or file
                  // metadata, so verify the current tier before sending it.
                  accessScope.aiChatsExported = true;
                }
              }
              if (includeAiChats) {
                // PostgreSQL counts visible rows and bytes inside this same
                // snapshot before the chat history is materialized in Node.
                const size = await db.prepare("", `SELECT COUNT(*) AS messages,
                    COALESCE(SUM(octet_length(m.content)),0) AS bytes
                  FROM ai_chats c JOIN ai_chat_messages m
                    ON m.archive_id=c.archive_id AND m.chat_id=c.id
                  WHERE c.user_id=? AND c.access_scope=?
                    AND (m.data->>'hidden') IS DISTINCT FROM 'true'`).get(accountId, scope);
                aiMessageBytes += BigInt(String(size?.bytes ?? 0));
                aiMessageCount += BigInt(String(size?.messages ?? 0));
                if (aiMessageBytes > BigInt(MAX_EXPORTED_AI_MESSAGE_BYTES) ||
                    aiMessageCount > BigInt(MAX_EXPORTED_AI_MESSAGES)) {
                  accessScope.aiChatsExported = true;
                  aiHistoryTooLarge = true;
                  continue;
                }
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
                      id: String(row.message_id),
                      role: String(row.role),
                      content: String(row.content),
                      createdAt: String(row.message_created_at),
                    });
                }
                accessScope.aiChatsExported ||= ownAiChats.length > 0;
              }
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
        if (jsonTooLarge) throw new AccountJsonTooLarge(accessScopes);
        if (aiHistoryTooLarge) throw new AccountAiHistoryTooLarge(accessScopes);
        return { accessScopes, aiAttachments, aiAttachmentError, download: {
          format: "drevo-account-data",
          version: 5,
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
          m.person_id,m.approved,a.revision,
          EXISTS(SELECT 1 FROM archive_owners o WHERE o.archive_id=m.archive_id
            AND o.user_id=m.user_id) AS owned FROM archive_memberships m
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
      validate?: (client: PoolClient) => Promise<boolean>,
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
              // Ownership can change while an already-admin recipient keeps
              // the same role and tree scope. Lock it with the archive before
              // validating the prepared account download.
              const owner = await client.query(
                "SELECT user_id FROM archive_owners WHERE archive_id=$1 FOR SHARE NOWAIT",
                [archiveId],
              );
              const membership = await client.query(
                `SELECT m.archive_id,m.role,m.tree_access,m.person_id,m.approved,a.revision
                 FROM archive_memberships m JOIN archives a ON a.id=m.archive_id
                 WHERE m.user_id=$1 AND m.archive_id=$2
                 FOR SHARE OF m,a NOWAIT`,
                [accountId, archiveId],
              );
              membershipRows.push(...membership.rows.map((row) => ({
                ...row,
                owned: owner.rows[0]?.user_id === accountId,
              })));
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
            if (validate && !(await validate(client))) return "access-changed";
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
