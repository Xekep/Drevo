import { randomUUID } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import type { ResearchAttachment } from "../shared/research-attachments.ts";
import { AI_CHAT_LIMIT } from "../shared/research-attachments.ts";
import type { GeneratedResearchFileMeta } from "./generated-research-files.ts";

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
  session_state: string;
  created_at: string;
  updated_at: string;
};

export type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
  hidden?: boolean;
  references?: unknown[];
  suggestionIds?: string[];
  files?: Array<{ name: string; url: string }>;
  generatedFileMeta?: GeneratedResearchFileMeta[];
  attachments?: ResearchAttachment[];
};

export function aiChatStore(db: StoreDatabase) {
  const getRow = db.prepare(
    `SELECT id,user_id,access_scope,yandex_conversation_id,session_state,created_at,updated_at
     FROM ai_chats WHERE id=? AND user_id=?`,
    "SELECT id,user_id,access_scope,yandex_conversation_id,session_state,created_at,updated_at\n     FROM ai_chats WHERE id=? AND user_id=?",
  );
  async function read(id: string, userId: string) {
    const row = (await getRow.get(id, userId)) as ChatRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      accessScope: row.access_scope,
      yandexConversationId: row.yandex_conversation_id,
      sessionState: JSON.parse(row.session_state) as {
        schemaVersion: number;
        activePersonIds: string[];
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return {
    read,
    async exists(id: string) {
      return !!(await db
        .prepare(
          "SELECT 1 FROM ai_chats WHERE id=?",
          "SELECT 1 FROM ai_chats WHERE id=?",
        )
        .get(id));
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
    async list(userId: string, accessScope: string) {
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
          row.access_scope === accessScope
            ? row.title?.slice(0, 80) || "Новый диалог"
            : "Диалог с прежними правами доступа",
        ...(row.access_scope !== accessScope ? { unavailable: true } : {}),
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
    async setRemote(id: string, conversationId: string | null) {
      await db
        .prepare(
          "UPDATE ai_chats SET yandex_conversation_id=? WHERE id=?",
          "UPDATE ai_chats SET yandex_conversation_id=? WHERE id=?",
        )
        .run(conversationId, id);
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
          `UPDATE ai_chats SET busy_token=?,busy_until=?
           WHERE id=? AND (busy_token IS NULL OR busy_until<?)`,
          "UPDATE ai_chats SET busy_token=?,busy_until=?\n           WHERE id=? AND (busy_token IS NULL OR busy_until<?)",
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
    async release(id: string, token: string) {
      await db
        .prepare(
          "UPDATE ai_chats SET busy_token=NULL,busy_until=NULL WHERE id=? AND busy_token=?",
          "UPDATE ai_chats SET busy_token=NULL,busy_until=NULL WHERE id=? AND busy_token=?",
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
      const row = await read(id, userId);
      if (row)
        await db
          .prepare(
            "DELETE FROM ai_chats WHERE id=? AND user_id=?",
            "DELETE FROM ai_chats WHERE id=? AND user_id=?",
          )
          .run(id, userId);
      return row;
    },
  };
}
