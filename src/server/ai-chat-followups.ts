import type { StoreDatabase } from "./store-database.ts";
import type { aiChatStore } from "./ai-chats.ts";

type FollowupState = {
  turn: string; closed: boolean; accepted: string[]; characters: number;
  receipts?: Record<string, number>;
  pending: Array<{ id: string; text: string }>;
};
export class FollowupError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** A bounded inbox inside the existing chat state; shared across backend processes.
 * The chat row serializes admission, draining, stop and the final-answer seal.
 */
export function aiChatFollowups(db: StoreDatabase, chats: ReturnType<typeof aiChatStore>) {
  const row = (id: string, userId: string) => db.prepare(
    "SELECT busy_token,busy_until,stop_token,session_state,access_scope FROM ai_chats WHERE id=? AND user_id=?",
    "SELECT busy_token,busy_until,stop_token,session_state,access_scope FROM ai_chats WHERE id=? AND user_id=? FOR UPDATE",
  ).get(id, userId);
  const state = (raw: Record<string, unknown>, token: string) => {
    const session = JSON.parse(String(raw.session_state)) as Record<string, unknown>;
    const stored = session.followups as FollowupState | undefined;
    const inbox: FollowupState = stored?.turn === token ? stored
      : { turn: token, closed: false, accepted: [], characters: 0, pending: [] };
    return { session, inbox };
  };
  const save = (id: string, session: Record<string, unknown>, inbox: FollowupState) =>
    db.prepare("UPDATE ai_chats SET session_state=? WHERE id=?",
      "UPDATE ai_chats SET session_state=? WHERE id=?")
      .run(JSON.stringify({ ...session, followups: inbox }), id);
  const active = (raw: Record<string, unknown> | undefined) => raw?.busy_token &&
    Number(raw.busy_until) > Date.now() && raw.stop_token !== raw.busy_token;
  return {
    async enqueue(id: string, userId: string, requestId: string, text: string,
      authorize: (scope: string) => Promise<boolean>) {
      if (!/^[a-f0-9-]{36}$/i.test(requestId) || !text.trim() || text.length > 8000)
        throw new FollowupError("Некорректное уточнение", 400);
      return db.transaction(async () => {
        const raw = await row(id, userId);
        if (!raw) throw new FollowupError("Диалог не найден", 404);
        if (!(await authorize(String(raw.access_scope)))) throw new FollowupError("Доступ к ИИ изменился", 403);
        const previous = (JSON.parse(String(raw.session_state)) as { followups?: FollowupState }).followups;
        const receipt = previous?.receipts?.[requestId];
        if (receipt) {
          const message = await db.prepare("SELECT id,change_version AS version,content FROM ai_chat_messages WHERE id=? AND chat_id=?",
            "SELECT id,change_version AS version,content FROM ai_chat_messages WHERE id=? AND chat_id=?").get(receipt, id);
          if (message && message.content === text)
            return { accepted: true, duplicate: true, message: { id: Number(message.id), version: Number(message.version), content: text, role: "user" as const } };
          throw new FollowupError("Идентификатор уточнения уже использован", 409);
        }
        if (!active(raw)) throw new FollowupError("Ответ уже завершён или остановлен. Отправьте новый запрос.", 409);
        const { session, inbox } = state(raw, String(raw.busy_token));
        if (inbox.accepted.includes(requestId)) return { accepted: true, duplicate: true };
        if (inbox.closed) throw new FollowupError("Ответ уже завершается. Отправьте новый запрос.", 409);
        if (inbox.accepted.length >= 8 || inbox.characters + text.length > 24000)
          throw new FollowupError("Слишком много уточнений за один ответ. Дождитесь завершения.", 429);
        inbox.accepted.push(requestId);
        inbox.characters += text.length;
        inbox.pending.push({ id: requestId, text });
        const messageId = await chats.append(id, "user", text, { followup: true });
        inbox.receipts = { ...inbox.receipts, [requestId]: messageId };
        const message = await db.prepare("SELECT id,change_version AS version FROM ai_chat_messages WHERE id=?",
          "SELECT id,change_version AS version FROM ai_chat_messages WHERE id=?").get(messageId);
        await save(id, session, inbox);
        return { accepted: true, duplicate: false, message: { id: Number(message!.id), version: Number(message!.version), role: "user" as const, content: text } };
      }, false, { archiveLock: "share", graphReadOnly: true });
    },
    async take(id: string, userId: string, token: string, seal = false) {
      return db.transaction(async () => {
        const raw = await row(id, userId);
        if (!active(raw) || raw!.busy_token !== token)
          throw new DOMException("Запрос остановлен или завершён", "AbortError");
        const { session, inbox } = state(raw!, token);
        const pending = inbox.pending.map(item => item.text);
        inbox.pending = [];
        if (seal && !pending.length) inbox.closed = true;
        if (pending.length || seal) await save(id, session, inbox);
        return pending;
      }, false, { archiveLock: "share", graphReadOnly: true });
    },
  };
}
