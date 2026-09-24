import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
};

export function aiChatStore(db: DatabaseSync) {
  const getRow = db.prepare(
    `SELECT id,user_id,access_scope,yandex_conversation_id,session_state,created_at,updated_at
     FROM ai_chats WHERE id=? AND user_id=?`,
  );
  function read(id: string, userId: string) {
    const row = getRow.get(id, userId) as ChatRow | undefined;
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
    create(userId: string, accessScope: string) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO ai_chats(id,user_id,access_scope) VALUES(?,?,?)",
      ).run(id, userId, accessScope);
      return read(id, userId)!;
    },
    list(userId: string, accessScope: string) {
      return (
        db
          .prepare(
            `SELECT ai_chats.id,updated_at,
             (SELECT content FROM ai_chat_messages
              WHERE chat_id=ai_chats.id AND role='user'
                AND json_extract(data,'$.hidden') IS NOT 1
              ORDER BY id LIMIT 1) AS title
           FROM ai_chats WHERE user_id=? AND access_scope=?
           ORDER BY updated_at DESC LIMIT 50`,
          )
          .all(userId, accessScope) as Array<{
          id: string;
          updated_at: string;
          title: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        updatedAt: row.updated_at,
        title: row.title?.slice(0, 80) || "Новый диалог",
      }));
    },
    messages(
      id: string,
      userId: string,
      includeHidden = false,
    ): AiChatMessage[] | null {
      if (!read(id, userId)) return null;
      return (
        db
          .prepare(
            `SELECT role,content,data FROM ai_chat_messages
           WHERE chat_id=? ORDER BY id`,
          )
          .all(id) as Array<{
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
    append(
      id: string,
      role: "user" | "assistant",
      content: string,
      data: unknown = {},
    ) {
      db.prepare(
        "INSERT INTO ai_chat_messages(chat_id,role,content,data) VALUES(?,?,?,?)",
      ).run(id, role, content, JSON.stringify(data));
      db.prepare(
        "UPDATE ai_chats SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      ).run(id);
    },
    setRemote(id: string, conversationId: string | null) {
      db.prepare("UPDATE ai_chats SET yandex_conversation_id=? WHERE id=?").run(
        conversationId,
        id,
      );
    },
    setActivePeople(id: string, personIds: string[]) {
      db.prepare("UPDATE ai_chats SET session_state=? WHERE id=?").run(
        JSON.stringify({
          schemaVersion: 1,
          activePersonIds: personIds.slice(-8),
        }),
        id,
      );
    },
    acquire(id: string) {
      const token = randomUUID();
      const result = db
        .prepare(
          `UPDATE ai_chats SET busy_token=?,busy_until=?
           WHERE id=? AND (busy_token IS NULL OR busy_until<?)`,
        )
        .run(token, Date.now() + 60_000, id, Date.now());
      return result.changes ? token : null;
    },
    renew(id: string, token: string) {
      db.prepare(
        "UPDATE ai_chats SET busy_until=? WHERE id=? AND busy_token=?",
      ).run(Date.now() + 60_000, id, token);
    },
    release(id: string, token: string) {
      db.prepare(
        "UPDATE ai_chats SET busy_token=NULL,busy_until=NULL WHERE id=? AND busy_token=?",
      ).run(id, token);
    },
    isBusy(id: string) {
      const row = db
        .prepare("SELECT busy_until FROM ai_chats WHERE id=?")
        .get(id);
      return (
        row && typeof row.busy_until === "number" && row.busy_until > Date.now()
      );
    },
    delete(id: string, userId: string) {
      const row = read(id, userId);
      if (row)
        db.prepare("DELETE FROM ai_chats WHERE id=? AND user_id=?").run(
          id,
          userId,
        );
      return row;
    },
  };
}
