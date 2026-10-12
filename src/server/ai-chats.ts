import { randomUUID } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import type { ResearchAttachment } from "../shared/research-attachments.ts";
import { AI_CHAT_LIMIT } from "../shared/research-attachments.ts";
import type { AiProviderCleanup } from "./ai-provider-cleanup.ts";
import type { GeneratedResearchFileMeta } from "./generated-research-files.ts";
import { AI_CHAT_HISTORY_PAGE_BYTES, AI_CHAT_HISTORY_PAGE_SIZE, type AiChatHead, type AiChatHistoryPage, type AiChatMessageDelta } from "../shared/ai-chat-history.ts";

export class AiChatLimitError extends Error {
  constructor() {
    super(
      "Можно сохранить не больше 10 диалогов. Удалите один из старых диалогов вместе с его вложениями, чтобы создать новый.",
    );
  }
}

type ChatRow = {
  id: string;
  user_id: string;
  access_scope: string;
  yandex_conversation_id: string | null;
  provider_cleanup_ref: string | null;
  session_state: string;
  created_at: string;
  updated_at: string;
};

export type AiChatMessage = {
  id?: number;
  version?: number;
  role: "user" | "assistant";
  content: string;
  hidden?: boolean;
  references?: unknown[];
  suggestionIds?: string[];
  suggestionStatuses?: Record<string, "pending" | "accepted" | "rejected">;
  files?: Array<{ name: string; url: string }>;
  generatedFileMeta?: GeneratedResearchFileMeta[];
  attachments?: ResearchAttachment[];
};

export function aiChatStore(db: StoreDatabase, cleanup?: AiProviderCleanup) {
  const getRow = db.prepare(
    `SELECT id,user_id,access_scope,yandex_conversation_id,provider_cleanup_ref,session_state,created_at,updated_at
     FROM ai_chats WHERE id=? AND user_id=?`,
    "SELECT id,user_id,access_scope,yandex_conversation_id,provider_cleanup_ref,session_state,created_at,updated_at\n     FROM ai_chats WHERE id=? AND user_id=?",
  );
  async function read(id: string, userId: string) {
    const row = (await getRow.get(id, userId)) as ChatRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      accessScope: row.access_scope,
      yandexConversationId: row.yandex_conversation_id,
      providerCleanupRef: row.provider_cleanup_ref,
      sessionState: JSON.parse(row.session_state) as {
        schemaVersion: number;
        activePersonIds: string[];
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  const publicMessage = (row: Record<string, unknown>): AiChatMessage & { id: number; version: number } => ({ ...JSON.parse(String(row.data)), ...(row.suggestion_states ? { suggestionStatuses: typeof row.suggestion_states === "string" ? JSON.parse(row.suggestion_states) : row.suggestion_states } : {}), role: row.role as "user" | "assistant", content: String(row.content), id: Number(row.id), version: Number(row.change_version) });
  const head = async (id: string, userId: string): Promise<AiChatHead | null> => {
    const row = await db.prepare(
      "SELECT messages_version,(SELECT COALESCE(max(id),0) FROM ai_chat_messages WHERE chat_id=ai_chats.id) AS latest FROM ai_chats WHERE id=? AND user_id=?",
      "SELECT messages_version,(SELECT COALESCE(max(id),0) FROM ai_chat_messages WHERE chat_id=ai_chats.id) AS latest FROM ai_chats WHERE id=? AND user_id=?",
    ).get(id, userId);
    return row ? { lastMessageId: Number(row.latest || 0), version: Number(row.messages_version || 0) } : null;
  };
  const selectBounded = async (id: string, cursor: number, changes: boolean) => {
    const where = changes ? "change_version>?" : "(?=0 OR id<?)";
    const order = changes ? "change_version,id" : "id DESC";
    const query = (postgres: boolean) => `WITH candidates AS (
      SELECT id,change_version,CASE WHEN ${postgres ? "(data->>'hidden')='true'" : "json_extract(data,'$.hidden')=1"} THEN 128 ELSE ${postgres ? "2*(octet_length(content)+octet_length(data::text))+128" : "2*(length(CAST(content AS BLOB))+length(CAST(data AS BLOB)))+128"} END AS bytes
      FROM ai_chat_messages WHERE chat_id=? AND ${where}${changes ? "" : postgres ? " AND (data->>'hidden') IS DISTINCT FROM 'true'" : " AND json_extract(data,'$.hidden') IS NOT 1"}
      ORDER BY ${order} LIMIT ?
    ), ranked AS (
      SELECT id,change_version,row_number() OVER (ORDER BY ${order}) AS position,
        sum(bytes) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS running_bytes FROM candidates
    ), chosen AS (SELECT id FROM ranked WHERE position<=? AND running_bytes<=?)
    SELECT m.id,m.change_version,m.role,
      CASE WHEN ${postgres ? "(m.data->>'hidden')='true'" : "json_extract(m.data,'$.hidden')=1"} THEN '' ELSE m.content END AS content,
      CASE WHEN ${postgres ? "(m.data->>'hidden')='true'" : "json_extract(m.data,'$.hidden')=1"} THEN ${postgres ? "jsonb_build_object('hidden',true)" : "json('{\"hidden\":true}')"} ELSE m.data END AS data,
      (SELECT count(*) FROM candidates) AS candidate_count,
      CASE WHEN ${postgres ? "(m.data->>'hidden')='true'" : "json_extract(m.data,'$.hidden')=1"} THEN NULL ELSE ${postgres
        ? "(SELECT jsonb_object_agg(s.id,s.status) FROM runtime_visible_research_suggestions s WHERE s.id IN (SELECT jsonb_array_elements_text(COALESCE(m.data->'suggestionIds','[]'::jsonb))))"
        : "(SELECT json_group_object(s.id,s.status) FROM research_suggestions s WHERE s.id IN (SELECT value FROM json_each(m.data,'$.suggestionIds')))"} END AS suggestion_states
    FROM (SELECT 1 AS singleton) seed LEFT JOIN chosen c ON 1=1
      LEFT JOIN ai_chat_messages m ON m.id=c.id AND m.chat_id=?
    ORDER BY ${changes ? "m.change_version,m.id" : "m.id DESC"}`;
    // Selection and body read share a single MVCC statement: a parallel edit
    // cannot enlarge a selected body or reveal a newly hidden internal prompt.
    const rows = await db.prepare(query(false), query(true)).all(id, ...(changes ? [cursor] : [cursor, cursor]), AI_CHAT_HISTORY_PAGE_SIZE + 1, AI_CHAT_HISTORY_PAGE_SIZE, AI_CHAT_HISTORY_PAGE_BYTES, id);
    const selected = rows.filter(row => row.id !== null && row.id !== undefined);
    const candidates = Number(rows[0]?.candidate_count || 0);
    if (!selected.length && candidates) throw new Error("Сообщение превышает размер страницы истории");
    return { records: selected.map(publicMessage), metadata: selected.map(row => ({ change_version: row.change_version })), hasMore: candidates > selected.length };
  };
  return {
    read,
    async assertProviderReady() { await cleanup?.assertReady(); },
    async exists(id: string) {
      return !!(await db
        .prepare(
          "SELECT 1 FROM ai_chats WHERE id=?",
          "SELECT 1 FROM ai_chats WHERE id=?",
        )
        .get(id));
    },
    async allIds() {
      const rows = await db
        .prepare("SELECT id FROM ai_chats", "SELECT id FROM ai_chats")
        .all();
      return new Set(rows.map((row) => String(row.id)));
    },
    async create(userId: string, accessScope: string) {
      return await db.transaction(async () => {
        // Serialize concurrent new chats for this account, including other server processes.
        if (db.kind === "postgres")
          await db
            .prepare(
              "SELECT 1",
              "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
            )
            .get(`ai-chats:${db.archiveId}:${userId}`);
        const count = await db
          .prepare(
            "SELECT count(*) AS total FROM ai_chats WHERE user_id=?",
            "SELECT count(*) AS total FROM ai_chats WHERE user_id=?",
          )
          .get(userId);
        if (Number(count?.total) >= AI_CHAT_LIMIT) throw new AiChatLimitError();
        const id = randomUUID();
        await db
          .prepare(
            "INSERT INTO ai_chats(id,user_id,access_scope) VALUES(?,?,?)",
            "INSERT INTO ai_chats(id,user_id,access_scope) VALUES(?,?,?)",
          )
          .run(id, userId, accessScope);
        return (await read(id, userId))!;
      });
    },
    async list(userId: string, accessScope: string | readonly string[]) {
      const allowedScopes = new Set(Array.isArray(accessScope) ? accessScope : [accessScope]);
      return (
        (await db
          .prepare(
            `SELECT ai_chats.id,updated_at,access_scope,
             (SELECT content FROM ai_chat_messages
              WHERE chat_id=ai_chats.id AND role='user'
                AND json_extract(data,'$.hidden') IS NOT 1
              ORDER BY id LIMIT 1) AS title
           FROM ai_chats WHERE user_id=?
           ORDER BY updated_at DESC`,
            "SELECT ai_chats.id,updated_at,access_scope,\n             (SELECT content FROM ai_chat_messages\n              WHERE chat_id=ai_chats.id AND role='user'\n                AND (data->>'hidden') IS DISTINCT FROM 'true'\n              ORDER BY id LIMIT 1) AS title\n           FROM ai_chats WHERE user_id=?\n           ORDER BY updated_at DESC",
          )
          .all(userId)) as Array<{
          id: string;
          updated_at: string;
          title: string | null;
          access_scope: string;
        }>
      ).map((row) => ({
        id: row.id,
        updatedAt: row.updated_at,
        title:
          allowedScopes.has(row.access_scope)
            ? row.title?.slice(0, 80) || "Новый диалог"
            : "Диалог с прежними правами доступа",
        ...(!allowedScopes.has(row.access_scope) ? { unavailable: true } : {}),
      }));
    },
    async messages(
      id: string,
      userId: string,
      includeHidden = false,
    ): Promise<AiChatMessage[] | null> {
      if (!(await read(id, userId))) return null;
      return (
        (await db
          .prepare(
            `SELECT role,content,data FROM ai_chat_messages
           WHERE chat_id=? ORDER BY id`,
            "SELECT role,content,data FROM ai_chat_messages\n           WHERE chat_id=? ORDER BY id",
          )
          .all(id)) as Array<{
          role: "user" | "assistant";
          content: string;
          data: string;
        }>
      )
        .map((row) => ({
          role: row.role,
          content: row.content,
          ...JSON.parse(row.data),
        }))
        .filter((message) => includeHidden || message.hidden !== true);
    },
    head,
    async historyPage(id: string, userId: string, before = 0): Promise<AiChatHistoryPage<AiChatMessage> | null> {
      if (!Number.isSafeInteger(before) || before < 0) throw new Error("Некорректная страница истории");
      const latest = await head(id, userId);
      if (!latest) return null;
      const page = await selectBounded(id, before, false);
      const messages = page.records.reverse();
      return { messages, nextBefore: page.hasMore ? messages[0].id : null, latestMessageId: latest.lastMessageId, latestVersion: latest.version, hasMore: page.hasMore };
    },
    async changesAfter(id: string, userId: string, version: number): Promise<AiChatMessageDelta<AiChatMessage> | null> {
      if (!Number.isSafeInteger(version) || version < 0) throw new Error("Некорректный указатель диалога");
      if (!(await read(id, userId))) return null;
      const page = await selectBounded(id, version, true);
      // Remove formerly visible records without revealing internal prompts.
      return { messages: page.records.map(message => message.hidden ? { id: message.id, version: message.version, role: message.role, content: "", hidden: true } : message), lastVersion: page.metadata.length ? Number(page.metadata.at(-1)!.change_version) : version, hasMore: page.hasMore };
    },
    async historySize(id: string, userId: string): Promise<number | null> {
      if (!(await read(id, userId))) return null;
      // Include JSON escaping and envelope overhead before allocating message objects.
      const row = await db.prepare(
        "SELECT COALESCE(sum(2*(length(CAST(content AS BLOB))+length(CAST(data AS BLOB)))+128*count(*),0) AS bytes FROM ai_chat_messages WHERE chat_id=?",
        "SELECT COALESCE(sum(2*(octet_length(content)+octet_length(data::text)))+128*count(*),0) AS bytes FROM ai_chat_messages WHERE chat_id=?",
      ).get(id);
      return Number(row?.bytes || 0);
    },
    async attachmentInventory(id: string, userId: string): Promise<ResearchAttachment[] | null> {
      if (!(await read(id, userId))) return null;
      const rows = await db.prepare(
        "SELECT json_extract(data,'$.attachments') AS attachments FROM ai_chat_messages WHERE chat_id=? AND json_type(data,'$.attachments')='array'",
        "SELECT data->'attachments' AS attachments FROM ai_chat_messages WHERE chat_id=? AND jsonb_typeof(data->'attachments')='array'",
      ).all(id);
      return rows.flatMap(row => { const value: unknown = typeof row.attachments === "string" ? JSON.parse(row.attachments) : row.attachments; return Array.isArray(value) ? value as ResearchAttachment[] : []; });
    },
    async append(
      id: string,
      role: "user" | "assistant",
      content: string,
      data: unknown = {},
    ) {
      await db
        .prepare(
          "INSERT INTO ai_chat_messages(chat_id,role,content,data) VALUES(?,?,?,?)",
          "INSERT INTO ai_chat_messages(chat_id,role,content,data) VALUES(?,?,?,?) RETURNING id",
        )
        .run(id, role, content, JSON.stringify(data));
      await db
        .prepare(
          "UPDATE ai_chats SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          "UPDATE ai_chats SET updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') WHERE id=?",
        )
        .run(id);
    },
    async setRemote(id: string, conversationId: string | null, token?: string) {
      const work = async () => {
        const row = await db.prepare(
          "SELECT provider_cleanup_ref FROM ai_chats WHERE id=?" + (token ? " AND busy_token=?" : ""),
          "SELECT provider_cleanup_ref FROM ai_chats WHERE id=?" + (token ? " AND busy_token=?" : "") + " FOR UPDATE",
        ).get(id, ...(token ? [token] : []));
        if (!row) return false;
        if (cleanup && conversationId) throw new Error("New provider conversation requires registration");
        const result = await db.prepare(
          "UPDATE ai_chats SET yandex_conversation_id=?,provider_cleanup_ref=NULL WHERE id=?" +
            (token ? " AND busy_token=?" : ""),
          "UPDATE ai_chats SET yandex_conversation_id=?,provider_cleanup_ref=NULL WHERE id=?" +
            (token ? " AND busy_token=?" : ""),
        ).run(conversationId, id, ...(token ? [token] : []));
        if (result.changes && row.provider_cleanup_ref && cleanup)
          await cleanup.pending(String(row.provider_cleanup_ref));
        return result.changes === 1;
      };
      // Admission may rekey a legacy chat inside the caller's write transaction.
      // Keep the remote reset and cleanup registration in that same commit.
      return db.inTransaction() ? await work() : await db.transaction(work);
    },
    async updateScope(id: string, userId: string, before: string, after: string,
      token: string) {
      const updated = await db.prepare(
        `UPDATE ai_chats SET access_scope=? WHERE id=? AND user_id=?
         AND access_scope=? AND busy_token=?`,
        `UPDATE ai_chats SET access_scope=? WHERE id=? AND user_id=?
         AND access_scope=? AND busy_token=?`,
      ).run(after, id, userId, before, token);
      return updated.changes === 1;
    },
    async bindNewRemote(id: string, conversationId: string, runtime: {
      baseUrl: string; folderId: string; apiKey: string
    }, token: string) {
      if (!cleanup) return await this.setRemote(id, conversationId, token);
      let ref: string;
      try {
        ref = await cleanup.register(id, conversationId, runtime);
      } catch (error) {
        // The POST already succeeded. Best-effort compensation uses the exact
        // creation credential if durable registration cannot complete.
        await cleanup.compensateKnown(id, conversationId, runtime);
        throw error;
      }
      return await this.bindRegisteredRemote(id, conversationId, token, ref);
    },
    async bindRegisteredRemote(id: string, conversationId: string, token: string, ref: string) {
      if (!cleanup) throw new Error("Provider cleanup is unavailable");
      const bound = await db.transaction(async () => {
        const previous = await db.prepare(
          "SELECT provider_cleanup_ref FROM ai_chats WHERE id=? AND busy_token=? AND busy_until>?",
          "SELECT provider_cleanup_ref FROM ai_chats WHERE id=? AND busy_token=? AND busy_until>? FOR UPDATE",
        ).get(id, token, Date.now());
        if (!previous) return false;
        const reserved = await db.prepare(
          "UPDATE platform_ai_conversations SET state='active',available_at=0,updated_at=? WHERE id=? AND local_chat_id=? AND archive_id=? AND state='binding' AND available_at>?",
          "UPDATE platform_ai_conversations SET state='active',available_at=0,updated_at=? WHERE id=? AND local_chat_id=? AND archive_id=? AND state='binding' AND available_at>?",
        ).run(Date.now(), ref, id, db.archiveId || "local", Date.now());
        if (reserved.changes !== 1) return false;
        const result = await db.prepare(
          "UPDATE ai_chats SET yandex_conversation_id=?,provider_cleanup_ref=? WHERE id=? AND busy_token=? AND busy_until>?",
          "UPDATE ai_chats SET yandex_conversation_id=?,provider_cleanup_ref=? WHERE id=? AND busy_token=? AND busy_until>?",
        ).run(conversationId, ref, id, token, Date.now());
        if (result.changes !== 1) throw new Error("AI chat binding was lost");
        if (previous.provider_cleanup_ref)
          await cleanup.pending(String(previous.provider_cleanup_ref));
        return true;
      });
      if (!bound) await cleanup.pending(ref);
      return bound;
    },
    async setActivePeople(id: string, personIds: string[]) {
      await db
        .prepare(
          "UPDATE ai_chats SET session_state=? WHERE id=?",
          "UPDATE ai_chats SET session_state=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            schemaVersion: 1,
            activePersonIds: personIds.slice(-8),
          }),
          id,
        );
    },
    async acquire(id: string) {
      const token = randomUUID();
      const result = await db
        .prepare(
          `UPDATE ai_chats SET busy_token=?,busy_until=?,stop_token=NULL
           WHERE id=? AND (busy_token IS NULL OR busy_until<?)`,
          "UPDATE ai_chats SET busy_token=?,busy_until=?,stop_token=NULL\n           WHERE id=? AND (busy_token IS NULL OR busy_until<?)",
        )
        .run(token, Date.now() + 60_000, id, Date.now());
      return result.changes ? token : null;
    },
    async renew(id: string, token: string) {
      const result = await db
        .prepare(
          "UPDATE ai_chats SET busy_until=? WHERE id=? AND busy_token=?",
          "UPDATE ai_chats SET busy_until=? WHERE id=? AND busy_token=?",
        )
        .run(Date.now() + 60_000, id, token);
      return result.changes === 1;
    },
    async requestStop(id: string, userId: string) {
      const work = async () => {
        await db
          .prepare(
            "UPDATE ai_chats SET stop_token=busy_token WHERE id=? AND user_id=? AND busy_token IS NOT NULL AND busy_until>?",
            "UPDATE ai_chats SET stop_token=busy_token WHERE id=? AND user_id=? AND busy_token IS NOT NULL AND busy_until>?",
          )
          .run(id, userId, Date.now());
      };
      if (db.inTransaction()) await work();
      else await db.transaction(work);
    },
    async turnStatus(id: string, token: string, lockForCommit = false): Promise<"active" | "stopped" | "lost"> {
      if (lockForCommit && !db.inTransaction())
        throw new Error("Фиксация ответа требует транзакции");
      const row = await db
        .prepare(
          "SELECT stop_token FROM ai_chats WHERE id=? AND busy_token=? AND busy_until>?",
          "SELECT stop_token FROM ai_chats WHERE id=? AND busy_token=? AND busy_until>?" +
            (lockForCommit ? " FOR UPDATE" : ""),
        )
        .get(id, token, Date.now());
      return !row ? "lost" : row.stop_token === token ? "stopped" : "active";
    },
    async release(id: string, token: string) {
      await db
        .prepare(
          "UPDATE ai_chats SET busy_token=NULL,busy_until=NULL,stop_token=NULL WHERE id=? AND busy_token=?",
          "UPDATE ai_chats SET busy_token=NULL,busy_until=NULL,stop_token=NULL WHERE id=? AND busy_token=?",
        )
        .run(id, token);
    },
    async isBusy(id: string) {
      const row = await db
        .prepare(
          "SELECT busy_until FROM ai_chats WHERE id=?",
          "SELECT busy_until FROM ai_chats WHERE id=?",
        )
        .get(id);
      return (
        row && typeof row.busy_until === "number" && row.busy_until > Date.now()
      );
    },
    async delete(id: string, userId: string) {
      return await db.transaction(async () => {
        const locked = await db.prepare(
          "SELECT id FROM ai_chats WHERE id=? AND user_id=?",
          "SELECT id FROM ai_chats WHERE id=? AND user_id=? FOR UPDATE",
        ).get(id, userId);
        if (!locked) return null;
        const row = await read(id, userId);
        if (!row) return null;
        if (row.providerCleanupRef && cleanup) await cleanup.pending(row.providerCleanupRef);
        await db.prepare(
          "DELETE FROM ai_chats WHERE id=? AND user_id=?",
          "DELETE FROM ai_chats WHERE id=? AND user_id=?",
        ).run(id, userId);
        return row;
      });
    },
  };
}
