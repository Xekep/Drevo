import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState } from "react";
import { Pencil, Send, Trash2 } from "lucide-react";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import { archiveTargetPath } from "../domain/archive-links";
import { scopedArchivePath } from "../domain/archive-context";
import {
  MAX_COMMENT_LENGTH,
  type PersonComment as Comment,
  type PersonDiscussionPage as Page,
  type CommentAttachment,
} from "../shared/person-discussion";
import CommentEditor from "./discussion/comment-editor";
import { CommentMarkdown } from "./discussion/comment-markdown";
import {
  AttachmentComposer,
  encodeCommentFiles,
} from "./discussion/attachment-composer";
import { MessageAttachments } from "./discussion/message-attachments";
import { AttachmentGallery } from "./discussion/attachment-gallery";

export function PersonDiscussion({
  personId,
  onSelect,
  onCountChange,
  readOnly = false,
}: {
  personId: string;
  onSelect: (id: string) => void;
  onCountChange: (total: number) => void;
  readOnly?: boolean;
}) {
  const [items, setItems] = useState<Comment[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [gallery, setGallery] = useState<{
    files: CommentAttachment[];
    id: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<{
    original: Comment;
    text: string;
    keep: string[];
    files: File[];
  } | null>(null);
  const endpoint = `/api/people/${encodeURIComponent(personId)}/discussion`;
  useUnsavedChanges(
    !!draft.trim() ||
      draftFiles.length > 0 ||
      (!!editing &&
        (editing.text !== editing.original.text ||
          editing.files.length > 0 ||
          editing.keep.length !== (editing.original.attachments || []).length)),
  );

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
        onCountChange(page.total ?? page.items.length);
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
  }, [endpoint, retry, onCountChange]);

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
      total?: number;
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
    if (result.total !== undefined) onCountChange(result.total);
    return result;
  }

  async function send() {
    const text = draft.trimEnd();
    if (
      (!text.trim() && !draftFiles.length) ||
      text.length > MAX_COMMENT_LENGTH ||
      loading ||
      pending ||
      editing
    )
      return;
    setPending(true);
    setError("");
    try {
      const result = await request(endpoint, "POST", {
        text,
        attachments: { keep: [], files: await encodeCommentFiles(draftFiles) },
      });
      const item = result.item;
      if (item) setItems((current) => [item, ...current]);
      setDraft("");
      setDraftFiles([]);
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
      (!editing.text.trim() && !editing.keep.length && !editing.files.length) ||
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
          attachments: {
            keep: editing.keep,
            files: await encodeCommentFiles(editing.files),
          },
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
      if (page.total !== undefined) onCountChange(page.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ошибка загрузки");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="person-discussion" aria-label="Обсуждение человека">
      {!readOnly && <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <CommentEditor
          label="Сообщение для обсуждения"
          value={draft}
          disabled={loading || pending || !!editing}
          onChange={setDraft}
          onSubmit={() => void send()}
        />
        <AttachmentComposer
          files={draftFiles}
          onChange={setDraftFiles}
          disabled={loading || pending || !!editing}
          onError={setError}
        />
        <div className="person-discussion-compose-footer">
          <small>
            {draft.length}/{MAX_COMMENT_LENGTH}
          </small>
          <button
            type="submit"
            disabled={
              (!draft.trim() && !draftFiles.length) ||
              draft.length > MAX_COMMENT_LENGTH ||
              loading ||
              pending ||
              !!editing
            }
          >
            <Send size={15} aria-hidden="true" /> Отправить
          </button>
        </div>
      </form>}
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
                {item.authorPersonId ? (
                  <a
                    className="person-discussion-author"
                    href={scopedArchivePath(
                      archiveTargetPath({
                        kind: "person",
                        id: item.authorPersonId,
                      }),
                    )}
                    aria-disabled={pending || !!editing || undefined}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      if (!pending && !editing) onSelect(item.authorPersonId!);
                    }}
                  >
                    {item.author}
                  </a>
                ) : (
                  <strong>{item.author}</strong>
                )}
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
                          setEditing({
                            original: item,
                            text: item.text,
                            keep: (item.attachments || []).map(
                              (file) => file.id,
                            ),
                            files: [],
                          });
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
                  <AttachmentComposer
                    files={editing.files}
                    retained={(editing.original.attachments || []).filter(
                      (file) => editing.keep.includes(file.id),
                    )}
                    onChange={(files) =>
                      setEditing((current) =>
                        current ? { ...current, files } : null,
                      )
                    }
                    onRemoveRetained={(id) =>
                      setEditing((current) =>
                        current
                          ? {
                              ...current,
                              keep: current.keep.filter((key) => key !== id),
                            }
                          : null,
                      )
                    }
                    disabled={pending}
                    onError={setError}
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
                          (!editing.text.trim() &&
                            !editing.keep.length &&
                            !editing.files.length) ||
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
                <>
                  <CommentMarkdown text={item.text} />
                  <MessageAttachments
                    files={item.attachments || []}
                    onOpen={(files, id) => setGallery({ files, id })}
                  />
                </>
              )}
              {!readOnly && item.canEdit && editing?.original.id !== item.id && (
                <button
                  type="button"
                  className="person-discussion-edit"
                  aria-label="Редактировать сообщение"
                  disabled={pending || !!editing}
                  onClick={() => {
                    setEditing({
                      original: item,
                      text: item.text,
                      keep: (item.attachments || []).map((file) => file.id),
                      files: [],
                    });
                    setConfirmDelete(null);
                    setError("");
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              )}
              {!readOnly && item.canDelete &&
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
      {gallery && (
        <AttachmentGallery
          files={gallery.files}
          initialId={gallery.id}
          onClose={() => setGallery(null)}
        />
      )}
    </section>
  );
}
