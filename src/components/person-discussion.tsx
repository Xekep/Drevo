import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useRef, useState } from "react";
import { Send, Trash2 } from "lucide-react";

type Comment = {
  id: number;
  text: string;
  author: string;
  createdAt: string;
  canDelete: boolean;
};
type Page = { items: Comment[]; nextBefore: number | null };

export function PersonDiscussion({ personId }: { personId: string }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [items, setItems] = useState<Comment[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const endpoint = `/api/people/${encodeURIComponent(personId)}/discussion`;

  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить обсуждение");
        return (await response.json()) as Page;
      })
      .then((page) => {
        setItems(page.items);
        setNextBefore(page.nextBefore);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Ошибка загрузки",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, retry]);

  async function request(
    url: string,
    method: "POST" | "DELETE",
    body?: unknown,
  ) {
    const response = await archiveFetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await response.json()) as {
      error?: string;
      item?: Comment;
    };
    if (!response.ok)
      throw new Error(result.error || "Не удалось выполнить действие");
    return result;
  }

  async function send() {
    const text = draft.trim();
    if (!text || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await request(endpoint, "POST", { text });
      const item = result.item;
      if (item) setItems((current) => [item, ...current]);
      setDraft("");
      if (textarea.current) textarea.current.style.height = "auto";
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось отправить сообщение",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(id: number) {
    setPending(true);
    setError("");
    try {
      await request(`${endpoint}/${id}`, "DELETE");
      setItems((current) => current.filter((item) => item.id !== id));
      setConfirmDelete(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось удалить сообщение",
      );
    } finally {
      setPending(false);
    }
  }

  async function loadMore() {
    if (nextBefore === null || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await archiveFetch(`${endpoint}?before=${nextBefore}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("Не удалось загрузить старые сообщения");
      const page = (await response.json()) as Page;
      setItems((current) => [...current, ...page.items]);
      setNextBefore(page.nextBefore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ошибка загрузки");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="person-discussion" aria-label="Обсуждение человека">
      <p className="person-discussion-intro">
        Вопросы, воспоминания и уточнения об этом человеке. Проверенные сведения
        добавляйте в карточку со ссылкой на источник.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor={`discussion-${personId}`}>
          Сообщение для обсуждения
        </label>
        <textarea
          ref={textarea}
          id={`discussion-${personId}`}
          value={draft}
          disabled={pending}
          maxLength={2000}
          rows={2}
          placeholder="Напишите вопрос или воспоминание…"
          onChange={(event) => setDraft(event.target.value)}
          onInput={(event) => {
            const field = event.currentTarget;
            field.style.height = "auto";
            field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
          }}
        />
        <div className="person-discussion-compose-footer">
          <small>{draft.length}/2000</small>
          <button type="submit" disabled={!draft.trim() || pending}>
            <Send size={15} aria-hidden="true" /> Отправить
          </button>
        </div>
      </form>
      {error && (
        <div role="alert" className="person-discussion-error">
          {error}
          {!loading && !items.length && (
            <button
              type="button"
              onClick={() => {
                setError("");
                setLoading(true);
                setRetry((value) => value + 1);
              }}
            >
              Повторить
            </button>
          )}
        </div>
      )}
      {loading ? (
        <p className="muted-copy">Загружаем обсуждение…</p>
      ) : items.length ? (
        <div className="person-discussion-list">
          {items.map((item) => (
            <article key={item.id} className="person-discussion-item">
              <div className="person-discussion-meta">
                <strong>{item.author}</strong>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("ru-RU", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </div>
              <p>{item.text}</p>
              {item.canDelete &&
                (confirmDelete === item.id ? (
                  <div className="person-discussion-delete-confirm">
                    <span>Удалить сообщение?</span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void remove(item.id)}
                    >
                      Удалить
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Отмена
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="person-discussion-delete"
                    aria-label="Удалить сообщение"
                    onClick={() => setConfirmDelete(item.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                ))}
            </article>
          ))}
          {nextBefore !== null && (
            <button
              type="button"
              className="person-discussion-more"
              disabled={pending}
              onClick={() => void loadMore()}
            >
              Показать старые сообщения
            </button>
          )}
        </div>
      ) : !error ? (
        <p className="muted-copy">Сообщений пока нет. Начните обсуждение.</p>
      ) : null}
    </section>
  );
}
