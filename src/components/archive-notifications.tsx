import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Bell, CheckCheck, MessageCircle, UserPlus } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { scopedArchivePath } from "../domain/archive-context.ts";
import type { ArchiveNotificationsPage } from "../shared/archive-notifications.ts";
import { EditorDialog } from "./editor-dialog";
import "../styles/archive-notifications.css";

export function ArchiveNotifications({
  beforeLeave,
}: {
  beforeLeave?: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ArchiveNotificationsPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(async (before = 0) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const response = await archiveFetch(
        `/api/notifications${before ? `?before=${before}` : ""}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error("Не удалось загрузить уведомления");
      const next = (await response.json()) as ArchiveNotificationsPage;
      if (controller.signal.aborted) return;
      setPage((current) =>
        before && current
          ? {
              ...next,
              items: [
                ...current.items,
                ...next.items.filter(
                  (item) => !current.items.some((old) => old.id === item.id),
                ),
              ],
            }
          : next,
      );
      setError("");
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    // Closed inboxes poll only in a visible tab. An open list stays stable while reading.
    const interval = setInterval(() => {
      if (!open && document.visibilityState === "visible") void load();
    }, 60_000);
    const foreground = () => {
      if (!open && document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", foreground);
      request.current?.abort();
    };
  }, [open, load, refresh]);
  const readAll = async () => {
    if (!page?.latest || busy) return;
    setBusy(true);
    try {
      const response = await archiveFetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ through: page.latest }),
      });
      if (!response.ok) throw new Error("Не удалось отметить уведомления");
      setPage((await response.json()) as ArchiveNotificationsPage);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>, id: number) => {
    const ordinary =
      event.button === 0 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey;
    if (ordinary && beforeLeave && !beforeLeave()) {
      event.preventDefault();
      return;
    }
    // Navigation keeps its real URL, including modified clicks/new tabs.
    void archiveFetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      keepalive: true,
    }).catch(() => {});
  };
  return (
    <>
      <button
        type="button"
        className="nav-notifications"
        onClick={() => setOpen(true)}
        aria-label={
          page?.unread
            ? `Уведомления: ${page.unread} непрочитанных`
            : "Уведомления"
        }
        title="Уведомления"
        aria-haspopup="dialog"
      >
        <Bell size={20} />
        {!!page?.unread && (
          <span className="notification-badge" aria-hidden="true">
            {page.unread > 99 ? "99+" : page.unread}
          </span>
        )}
      </button>
      {open && (
        <EditorDialog
          title="Уведомления"
          onClose={() => setOpen(false)}
          dismissOnOutside
          className="notifications-dialog"
          headerActions={
            page?.unread ? (
              <button
                type="button"
                className="icon-button"
                onClick={() => void readAll()}
                disabled={busy}
                aria-label="Прочитать все"
                title="Прочитать все"
              >
                <CheckCheck size={20} />
              </button>
            ) : undefined
          }
        >
          <div className="notifications-list" aria-busy={busy}>
            {error && (
              <p role="alert">
                {error}{" "}
                <button
                  type="button"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  Повторить
                </button>
              </p>
            )}
            {!page && !error && <p role="status">Загрузка…</p>}
            {page && !page.items.length && (
              <p className="notifications-empty">
                Здесь появятся новые люди и комментарии в обсуждениях вашего
                древа.
              </p>
            )}
            {page?.items.map((item) => (
              <a
                key={item.id}
                className={`notification-item${item.read ? "" : " is-unread"}`}
                href={scopedArchivePath(
                  `/people/${encodeURIComponent(item.personId)}${item.kind === "person_comment" ? "#discussion" : ""}`,
                )}
                onClick={(event) => follow(event, item.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) follow(event, item.id);
                }}
              >
                {item.kind === "person_added" ? (
                  <UserPlus size={18} aria-hidden="true" />
                ) : (
                  <MessageCircle size={18} aria-hidden="true" />
                )}
                <span className="notification-content">
                  <strong>{item.personName}</strong>
                  <span>
                    {item.kind === "person_added"
                      ? "Добавлен человек"
                      : "Новый комментарий"}{" "}
                    · {item.actorName}
                  </span>
                  <time dateTime={item.at}>
                    {new Date(item.at).toLocaleString("ru-RU", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  {!item.read && <span className="sr-only">Не прочитано</span>}
                </span>
              </a>
            ))}
            {page?.next && (
              <button
                type="button"
                className="notifications-more"
                disabled={busy}
                onClick={() => void load(page.next!)}
              >
                Ещё уведомления
              </button>
            )}
          </div>
        </EditorDialog>
      )}
    </>
  );
}
