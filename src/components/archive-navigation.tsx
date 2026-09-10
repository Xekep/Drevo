import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  TreeDeciduous,
  Users,
  Image,
  Heart,
  ShieldCheck,
  Search,
  Plus,
  LogOut,
  CircleHelp,
  Menu,
  MapPin,
  Download,
} from "lucide-react";
import {
  fullName,
  years,
  matchesPerson,
  type Person,
  type ArchiveUser,
} from "../domain";
import type { ArchiveView } from "../domain/archive-routes";
export type { ArchiveView } from "../domain/archive-routes";
export function ArchiveNavigation({
  view,
  onView,
  user,
  local,
  readTree,
  readPhotos,
  onHelp,
  desktop,
}: {
  view: ArchiveView;
  onView: (view: ArchiveView) => void;
  user: ArchiveUser | null;
  local: boolean;
  readTree: boolean;
  readPhotos: boolean;
  onHelp: () => void;
  desktop: boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (menu.current && !menu.current.contains(e.target as Node))
        menu.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <nav className="archive-nav" aria-label="Разделы архива">
      <button
        className="nav-brand"
        onClick={() => onView("tree")}
        aria-label="Древо"
      >
        <TreeDeciduous size={32} strokeWidth={1.5} />
        <span>древо.</span>
      </button>
      <div className="nav-sections">
        {(
          [
            ["tree", "Древо", TreeDeciduous],
            ["list", "Люди", Users],
            ["families", "Семьи", Heart],
            ["gallery", "Фото", Image],
            ["places", "Места", MapPin],
          ] as const
        )
          .filter(([id]) =>
            id === "gallery"
              ? readPhotos
              : id === "places"
                ? readTree || readPhotos
                : readTree,
          )
          .map(([id, label, Icon]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => onView(id)}
            >
              <Icon size={22} strokeWidth={1.5} />
              <span>{label}</span>
            </button>
          ))}
      </div>
      <details ref={menu} className="archive-more" key={view}>
        <summary aria-label="Меню проекта">
          <Menu size={20} />
        </summary>
        <div className="nav-bottom">
          <div className="mobile-sections">
            {(
              [
                ["tree", "Древо", TreeDeciduous],
                ["list", "Люди", Users],
                ["families", "Семьи", Heart],
                ["gallery", "Фото", Image],
                ["places", "Места", MapPin],
              ] as const
            )
              .filter(([id]) =>
                id === "gallery"
                  ? readPhotos
                  : id === "places"
                    ? readTree || readPhotos
                    : readTree,
              )
              .map(([id, label, Icon]) => (
                <button
                  key={id}
                  aria-current={view === id ? "page" : undefined}
                  onClick={() => onView(id)}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
          </div>
          <button
            onClick={() => {
              if (menu.current) menu.current.open = false;
              onHelp();
            }}
            title="О проекте"
          >
            <CircleHelp size={18} />
            <span>О проекте</span>
          </button>
          {readTree && (
            <a
              href="/api/export.json?download=1"
              download="drevo-family.json"
              onClick={() => {
                if (menu.current) menu.current.open = false;
              }}
            >
              <Download size={18} />
              <span>Экспорт JSON без фото</span>
            </a>
          )}
          {user?.role === "admin" && desktop && (
            <button
              aria-current={view === "admin" ? "page" : undefined}
              onClick={() => onView("admin")}
              title="Админская панель"
            >
              <ShieldCheck size={22} />
              <span>Админка</span>
            </button>
          )}
          {user && !local && (
            <form action="/auth/logout" method="post">
              <button title="Выйти">
                <LogOut size={20} />
                <span>Выйти</span>
              </button>
            </form>
          )}
          {!desktop && (
            <p>
              Просмотр на телефоне.
              <br />
              Редактирование — с компьютера.
            </p>
          )}
        </div>
      </details>
    </nav>
  );
}
export function ArchiveHeader({
  people,
  query,
  onQuery,
  onSelect,
  onAdd,
  canEdit,
  busy,
  onLogin,
  user,
  navigation,
}: {
  people: Person[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  canEdit: boolean;
  busy: boolean;
  onLogin: () => void;
  user: ArchiveUser | null;
  navigation: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !(e.target as HTMLElement).closest("[role=dialog], dialog") &&
        (e.target === ref.current ||
          !(e.target as HTMLElement).closest(
            "input,textarea,select,[contenteditable]",
          ))
      ) {
        onQuery("");
        setOpen(false);
      }
      if (
        e.key === "/" &&
        !(e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      ) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onQuery]);
  const matches = query.trim()
    ? people.filter((p) => matchesPerson(p, query)).slice(0, 8)
    : [];
  return (
    <header className="archive-header">
      {navigation}
      <div
        className="archive-search"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
        }}
      >
        <Search size={19} />
        <input
          ref={ref}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) {
              onSelect(matches[0].id);
              setOpen(false);
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              onQuery("");
              setOpen(false);
            }
          }}
          placeholder="Найти человека…"
          aria-label="Найти человека"
        />
        <kbd>/</kbd>
        {open && query.trim() && (
          <div className="archive-search-results">
            {matches.length ? (
              matches.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelect(p.id);
                    setOpen(false);
                  }}
                >
                  <b>{fullName(p)}</b>
                  {years(p) && <small>{years(p)}</small>}
                </button>
              ))
            ) : (
              <p>Никого не нашли</p>
            )}
          </div>
        )}
      </div>
      <div className="archive-header-actions">
        {busy && <span role="status">Сохраняем…</span>}
        {canEdit && (
          <button className="primary-action" onClick={onAdd} disabled={busy}>
            <Plus size={18} />
            <span>Добавить</span>
          </button>
        )}
        {!user && (
          <button className="login-action" onClick={onLogin}>
            Войти
          </button>
        )}
      </div>
    </header>
  );
}
