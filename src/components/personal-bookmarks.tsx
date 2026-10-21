import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bookmark, BookmarkCheck, Trash2, X } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { scopedArchivePath } from "../domain/archive-context.ts";
import type {
  BookmarkTarget,
  PersonalBookmark,
} from "../shared/personal-research.ts";
import "../styles/personal-research.css";

const keyOf = (target: BookmarkTarget) => `${target.kind}:${target.id}`;
type Library = {
  items: PersonalBookmark[];
  unavailable: number;
  busy: boolean;
  error: string;
  reload: () => void;
  toggle: (target: BookmarkTarget) => Promise<void>;
  clearUnavailable: () => Promise<void>;
};
const Bookmarks = createContext<Library | null>(null);

export function PersonalBookmarks({
  enabled,
  scopeKey,
  children,
}: {
  enabled: boolean;
  scopeKey: string;
  children: ReactNode;
}) {
  const empty = {
    scopeKey,
    items: [] as PersonalBookmark[],
    unavailable: 0,
    busy: false,
    error: "",
    loaded: false,
  };
  const [state, setState] = useState(empty);
  const { items, unavailable, busy, error, loaded } =
    state.scopeKey === scopeKey ? state : empty;
  const [attempt, setAttempt] = useState(0);
  const writing = useRef<symbol | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (enabled) {
      void archiveFetch("/api/bookmarks", { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error || "Закладки не загрузились");
          if (!controller.signal.aborted) {
            setState({
              scopeKey,
              items: data.items,
              unavailable: data.unavailable || 0,
              busy: false,
              error: "",
              loaded: true,
            });
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) {
            setState({
              scopeKey,
              items: [],
              unavailable: 0,
              busy: false,
              error: String(reason.message),
              loaded: true,
            });
          }
        });
    }
    return () => {
      controller.abort();
      writing.current = null;
    };
  }, [enabled, attempt, scopeKey]);
  const mutate = async (body: Record<string, unknown>) => {
    const controller = lifetime.current;
    if (
      writing.current ||
      !enabled ||
      !loaded ||
      !controller ||
      controller.signal.aborted
    )
      return;
    const operation = Symbol();
    writing.current = operation;
    setState((previous) =>
      previous.scopeKey === scopeKey ? { ...previous, busy: true } : previous,
    );
    try {
      const response = await archiveFetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось сохранить закладку");
      if (!controller.signal.aborted) {
        setState((previous) =>
          previous.scopeKey === scopeKey
            ? {
                ...previous,
                items: data.items,
                unavailable: data.unavailable || 0,
                error: "",
              }
            : previous,
        );
      }
    } catch (reason) {
      if (!controller.signal.aborted) throw reason;
    } finally {
      if (writing.current === operation) writing.current = null;
      if (!controller.signal.aborted)
        setState((previous) =>
          previous.scopeKey === scopeKey
            ? { ...previous, busy: false }
            : previous,
        );
    }
  };
  return (
    <Bookmarks.Provider
      value={
        enabled
          ? {
              items,
              unavailable,
              busy: busy || !loaded,
              error,
              toggle: (target) =>
                mutate({
                  ...target,
                  remove: items.some((item) => keyOf(item) === keyOf(target)),
                }),
              clearUnavailable: () => mutate({ clearUnavailable: true }),
              reload: () => {
                setState((previous) =>
                  previous.scopeKey === scopeKey
                    ? { ...previous, loaded: false }
                    : previous,
                );
                setAttempt((value) => value + 1);
              },
            }
          : null
      }
    >
      {children}
    </Bookmarks.Provider>
  );
}

export function BookmarkButton({ target }: { target: BookmarkTarget }) {
  const library = useContext(Bookmarks);
  const [error, setError] = useState("");
  if (!library) return null;
  const selected = library.items.some((item) => keyOf(item) === keyOf(target));
  return (
    <>
      <button
        type="button"
        className="bookmark-button icon-button"
        disabled={library.busy || !!library.error}
        aria-pressed={selected}
        aria-label={selected ? "Удалить из закладок" : "Добавить в закладки"}
        title={
          library.error ||
          (selected ? "Удалить из закладок" : "Добавить в закладки")
        }
        onClick={() => {
          setError("");
          void library
            .toggle(target)
            .catch((reason) => setError(reason.message));
        }}
      >
        {selected ? (
          <BookmarkCheck size={17} aria-hidden="true" />
        ) : (
          <Bookmark size={17} aria-hidden="true" />
        )}
      </button>
      {error && (
        <span className="form-error bookmark-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export function BookmarksMenu({
  beforeLeave,
}: {
  beforeLeave?: () => boolean;
}) {
  const library = useContext(Bookmarks);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const place = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect || !panel.current) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const width = Math.min(390, right - left - 16);
    const panelTop = Math.max(top + 8, Math.min(rect.bottom + 8, bottom - 140));
    Object.assign(panel.current.style, {
      width: `${width}px`,
      left: `${Math.max(left + 8, Math.min(rect.right - width, right - width - 8))}px`,
      top: `${panelTop}px`,
      maxHeight: `${Math.min(520, bottom - panelTop - 8)}px`,
    });
  }, []);
  useEffect(() => {
    if (!open) return;
    place();
    const onScroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !panel.current?.contains(event.target)
      )
        place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, place]);
  if (!library) return null;
  const list = library.items.filter((item) =>
    item.label
      .toLocaleLowerCase("ru")
      .includes(query.trim().toLocaleLowerCase("ru")),
  );
  return (
    <>
      <button
        type="button"
        className="nav-bookmarks"
        ref={button}
        popoverTarget={id}
        aria-expanded={open}
        onClick={() => {
          place();
          if (!open) library.reload();
        }}
        aria-label="Личные закладки"
        title="Личные закладки"
      >
        <Bookmark size={20} aria-hidden="true" />
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        onToggle={(event) => setOpen(event.newState === "open")}
        role="region"
        className="bookmarks-popover"
        aria-label="Личные закладки"
      >
        <header>
          <h2>Закладки</h2>
          <button
            type="button"
            className="icon-button"
            popoverTarget={id}
            popoverTargetAction="hide"
            aria-label="Закрыть закладки"
          >
            <X size={18} />
          </button>
        </header>
        <div className="bookmarks-content">
          <input
            type="search"
            aria-label="Найти в закладках"
            placeholder="Найти в закладках"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {(error || library.error) && (
            <p role="alert" className="form-error">
              {error || library.error}
            </p>
          )}
          {library.error && (
            <button
              type="button"
              disabled={library.busy}
              onClick={library.reload}
            >
              Повторить загрузку
            </button>
          )}
          {library.unavailable > 0 && (
            <button
              type="button"
              disabled={library.busy}
              onClick={() => {
                setError("");
                void library
                  .clearUnavailable()
                  .catch((reason) => setError(reason.message));
              }}
            >
              Убрать недоступные · {library.unavailable}
            </button>
          )}
          {library.busy && !library.items.length && (
            <p role="status">Загружаем закладки…</p>
          )}
          {!library.busy && !list.length && (
            <p className="muted-copy">
              {library.items.length
                ? "Совпадений нет."
                : "Сохраняйте людей, фотографии и документы кнопкой закладки."}
            </p>
          )}
          <ul>
            {list.map((item) => (
              <li key={keyOf(item)}>
                <a
                  href={scopedArchivePath(item.href)}
                  onClick={(event) => {
                    if (
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.shiftKey &&
                      !event.altKey &&
                      beforeLeave &&
                      !beforeLeave()
                    )
                      event.preventDefault();
                  }}
                >
                  <span>{item.label}</span>
                  <small>
                    {item.kind === "person"
                      ? "Человек"
                      : item.kind === "photo"
                        ? "Фотография"
                        : "Документ"}
                  </small>
                </a>
                <button
                  type="button"
                  className="icon-button"
                  disabled={library.busy}
                  aria-label={`Удалить закладку: ${item.label}`}
                  onClick={() => {
                    setError("");
                    void library
                      .toggle(item)
                      .catch((reason) => setError(reason.message));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
