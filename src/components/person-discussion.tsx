import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import { Pencil, Send, Trash2 } from "lucide-react";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import {
  MAX_COMMENT_LENGTH,
  type PersonComment as Comment,
  type PersonDiscussionPage as Page,
} from "../shared/person-discussion";
import CommentEditor from "./discussion/comment-editor";
import { CommentMarkdown } from "./discussion/comment-markdown";

export function PersonDiscussion({ personId }: { personId: string }) {
  const [items, setItems] = useState<Comment[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<{
    original: Comment;
    text: string;
  } | null>(null);
  const endpoint = `/api/people/${encodeURIComponent(personId)}/discussion`;
  useUnsavedChanges(!!editing && editing.text !== editing.original.text);

  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch(endpoint, {
      signal: controller.signal,
      cache: "no-store",
    })
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
    method: "POST" | "DELETE" | "PATCH",
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
    if (!response.ok) {
      if (response.status === 409 && result.item) {
        const latest = result.item;
        setItems((current) =>
          current.map((item) => (item.id === latest.id ? latest : item)),
        );
      }
      throw new Error(result.error || "Не удалось выполнить действие");
    }
    return result;
  }

  async function send() {
    const text = draft.trimEnd();
    if (!text.trim() || text.length > MAX_COMMENT_LENGTH || pending || editing)
      return;
    setPending(true);
    setError("");
    try {
      const result = await request(endpoint, "POST", { text });
      const item = result.item;
      if (item) setItems((current) => [item, ...current]);
      setDraft("");
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

  async function saveEdit() {
    if (
      !editing ||
      pending ||
      !editing.text.trim() ||
      editing.text.length > MAX_COMMENT_LENGTH
    )
      return;
    setPending(true);
    setError("");
    try {
      const result = await request(
        `${endpoint}/${editing.original.id}`,
        "PATCH",
        {
          text: editing.text.trimEnd(),
          editedAt: editing.original.editedAt,
        },
      );
      const saved = result.item;
      if (saved)
        setItems((current) =>
          current.map((item) => (item.id === saved.id ? saved : item)),
        );
      setEditing(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить сообщение",
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
        <CommentEditor
          label="Сообщение для обсуждения"
          value={draft}
          disabled={pending || !!editing}
          onChange={setDraft}
          onSubmit={() => void send()}
        />
        <div className="person-discussion-compose-footer">
          <small>
            {draft.length}/{MAX_COMMENT_LENGTH}
          </small>
          <button
            type="submit"
            disabled={
              !draft.trim() ||
              draft.length > MAX_COMMENT_LENGTH ||
              pending ||
              !!editing
            }
          >
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
            <article
              key={item.id}
              data-comment-id={item.id}
              className="person-discussion-item"
            >
              <div className="person-discussion-meta">
                <strong>{item.author}</strong>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("ru-RU", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
                {item.editedAt && (
                  <time
                    className="person-discussion-edited"
                    dateTime={item.editedAt}
                    title={`Изменено ${new Date(item.editedAt).toLocaleString("ru-RU")}`}
                  >
                    изменено
                  </time>
                )}
              </div>
              {editing?.original.id === item.id ? (
                <form
                  className="person-discussion-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit();
                  }}
                >
                  {item.editedAt !== editing.original.editedAt && (
                    <div className="person-discussion-conflict" role="status">
                      <p>Актуальная версия сообщения:</p>
                      <CommentMarkdown text={item.text} />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setEditing({ original: item, text: item.text });
                          setError("");
                        }}
                      >
                        Загрузить актуальный текст
                      </button>
                    </div>
                  )}
                  <CommentEditor
                    label="Редактирование сообщения"
                    value={editing.text}
                    disabled={pending}
                    focusOnMount
                    onChange={(text) =>
                      setEditing((current) =>
                        current ? { ...current, text } : null,
                      )
                    }
                    onSubmit={() => void saveEdit()}
                  />
                  <div className="person-discussion-compose-footer">
                    <small>
                      {editing.text.length}/{MAX_COMMENT_LENGTH}
                    </small>
                    <div className="person-discussion-edit-buttons">
                      <button
                        type="submit"
                        disabled={
                          pending ||
                          !editing.text.trim() ||
                          editing.text.length > MAX_COMMENT_LENGTH
                        }
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setEditing(null);
                          setError("");
                        }}
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <CommentMarkdown text={item.text} />
              )}
              {item.canEdit && editing?.original.id !== item.id && (
                <button
                  type="button"
                  className="person-discussion-edit"
                  aria-label="Редактировать сообщение"
                  disabled={pending || !!editing}
                  onClick={() => {
                    setEditing({ original: item, text: item.text });
                    setConfirmDelete(null);
                    setError("");
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              )}
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
                    disabled={pending || !!editing}
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
