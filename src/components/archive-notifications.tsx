import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  CheckCheck,
  MessageCircle,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { scopedArchivePath } from "../domain/archive-context.ts";
import { useArchiveNotifications } from "../hooks/useArchiveNotifications.ts";
import "../styles/archive-notifications.css";

export function ArchiveNotifications({
  userId,
  beforeLeave,
}: {
  userId: string;
  beforeLeave?: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const {
    page,
    error,
    busy,
    load,
    readAll,
    markRead,
    soundEnabled,
    toggleSound,
  } = useArchiveNotifications({ userId, open });
  const bell = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = bell.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(390, window.innerWidth - 16);
      const top = Math.max(
        8,
        Math.min(anchor.bottom + 8, window.innerHeight - 140),
      );
      setPosition({
        left: Math.max(
          8,
          Math.min(anchor.right - width, window.innerWidth - width - 8),
        ),
        top,
        width,
        maxHeight: Math.min(520, window.innerHeight - top - 8),
      });
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target))
        return;
      place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const focus = requestAnimationFrame(() => panel.current?.focus());
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        panel.current?.contains(event.target) ||
        bell.current?.contains(event.target)
      )
        return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      bell.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const follow = (
    event: MouseEvent<HTMLAnchorElement>,
    notificationId: number,
  ) => {
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
    // Keep real URLs and modified clicks. Only authorized navigation marks read.
    void markRead(notificationId);
    if (ordinary) setOpen(false);
  };
  return (
    <>
      <button
        ref={bell}
        type="button"
        className="nav-notifications"
        onClick={() => setOpen((value) => !value)}
        aria-label={
          page?.unread
            ? `Уведомления: ${page.unread} непрочитанных`
            : "Уведомления"
        }
        title="Уведомления"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
      >
        <Bell size={20} aria-hidden="true" />
        {!!page?.unread && (
          <span className="notification-badge" aria-hidden="true">
            {page.unread > 99 ? "99+" : page.unread}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={`${id}-panel`}
            role="dialog"
            aria-modal="false"
            aria-labelledby={`${id}-title`}
            tabIndex={-1}
            className="notifications-dropdown"
            style={position ?? { visibility: "hidden" }}
          >
            <header>
              <h2 id={`${id}-title`}>Уведомления</h2>
              <button
                type="button"
                className="notification-action"
                onClick={() => void readAll()}
                disabled={busy || !page?.unread}
                aria-label="Прочитать все"
                title="Прочитать все"
              >
                <CheckCheck size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="notification-action"
                onClick={toggleSound}
                aria-pressed={soundEnabled}
                aria-label={
                  soundEnabled
                    ? "Выключить звук уведомлений"
                    : "Включить звук уведомлений"
                }
                title={
                  soundEnabled
                    ? "Выключить звук уведомлений"
                    : "Включить звук уведомлений"
                }
              >
                {soundEnabled ? (
                  <Volume2 size={18} aria-hidden="true" />
                ) : (
                  <VolumeX size={18} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="notification-action"
                aria-label="Закрыть уведомления"
                title="Закрыть уведомления"
                onClick={() => {
                  setOpen(false);
                  bell.current?.focus();
                }}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="notifications-list" aria-busy={busy}>
              {error && (
                <p role="alert">
                  {error}{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void load()}
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
                    {!item.read && (
                      <span className="sr-only">Не прочитано</span>
                    )}
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
          </div>,
          document.body,
        )}
    </>
  );
}
