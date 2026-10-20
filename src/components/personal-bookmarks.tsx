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
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [items, setItems] = useState<PersonalBookmark[]>([]);
  const [unavailable, setUnavailable] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const writing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (enabled) {
      void archiveFetch("/api/bookmarks", { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error || "Закладки не загрузились");
          if (!controller.signal.aborted) {
            setItems(data.items);
            setUnavailable(data.unavailable || 0);
            setError("");
            setLoaded(true);
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) {
            setError(String(reason.message));
            setItems([]);
            setLoaded(true);
          }
        });
    }
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [enabled, attempt]);
  const mutate = async (body: Record<string, unknown>) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    try {
      const response = await archiveFetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось сохранить закладку");
      if (mounted.current) {
        setItems(data.items);
        setUnavailable(data.unavailable || 0);
        setError("");
      }
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
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
                setLoaded(false);
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
    panel.current.style.top = `${Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 200))}px`;
    panel.current.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
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
        onClick={() => { place(); if (!open) library.reload(); }}
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
    </>
  );
}
