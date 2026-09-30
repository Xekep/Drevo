import { useEffect, useState } from "react";
import { MessageSquareText, Trash2 } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";

type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
  unavailable?: boolean;
};

const updated = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(value))
    : "";

export function AccountAiHistory({ accountId }: { accountId: string }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch("/api/ai/chats", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить диалоги");
        return (await response.json()) as { chats: ChatSummary[] };
      })
      .then((result) => {
        if (!controller.signal.aborted) setChats(result.chats);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Не удалось загрузить диалоги");
      });
    return () => controller.abort();
  }, [accountId]);

  const remove = async (id: string) => {
    setDeletingId(id);
    setError("");
    try {
      const response = await archiveFetch(`/api/ai/chats/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Не удалось удалить диалог");
      setChats((previous) => previous?.filter((chat) => chat.id !== id) || []);
      setConfirmId(null);
    } catch {
      setError("Не удалось удалить диалог. Попробуйте ещё раз.");
    } finally {
      setDeletingId(null);
    }
  };

  if (chats?.length === 0 && !error) return null;
  return (
    <section className="account-card" aria-labelledby="account-ai-history-title">
      <div className="account-card-title">
        <span className="account-icon"><MessageSquareText size={20} /></span>
        <div>
          <span className="account-eyebrow">Личные данные</span>
          <h2 id="account-ai-history-title">Диалоги с ИИ</h2>
        </div>
      </div>
      {chats === null && !error && <p className="account-card-copy" role="status">Загружаем диалоги…</p>}
      {chats && <div className="account-ai-chat-list">
        {chats.map((chat) => (
          <div className="account-ai-chat" key={chat.id}>
            <span className="account-ai-chat-name">
              <strong>{chat.title}</strong>
              <small>{updated(chat.updatedAt)}{chat.unavailable ? " · Содержимое недоступно" : ""}</small>
            </span>
            {confirmId === chat.id ? (
              <span className="account-ai-chat-actions">
                <button type="button" disabled={deletingId === chat.id} onClick={() => void remove(chat.id)}>
                  {deletingId === chat.id ? "Удаляем…" : "Удалить"}
                </button>
                <button type="button" disabled={deletingId === chat.id} onClick={() => setConfirmId(null)}>Отмена</button>
              </span>
            ) : (
              <button type="button" className="account-ai-chat-delete" aria-label={`Удалить диалог: ${chat.title}`} onClick={() => setConfirmId(chat.id)}>
                <Trash2 size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>}
      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  );
}
