import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import {
  fullName,
  years,
  matchesPerson,
  type Person,
  type ArchiveUser,
} from "../domain";
export type ArchiveView = "tree" | "list" | "families" | "gallery" | "admin";
export function ArchiveNavigation({
  view,
  onView,
  user,
  local,
  readTree,
  readPhotos,
  onHelp,
}: {
  view: ArchiveView;
  onView: (view: ArchiveView) => void;
  user: ArchiveUser | null;
  local: boolean;
  readTree: boolean;
  readPhotos: boolean;
  onHelp: () => void;
}) {
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
          ] as const
        )
          .filter(([id]) => (id === "gallery" ? readPhotos : readTree))
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
      <div className="nav-bottom">
        {user?.role === "admin" && (
          <button
            aria-current={view === "admin" ? "page" : undefined}
            onClick={() => onView("admin")}
            title="Админская панель"
          >
            <ShieldCheck size={22} />
            <span>Админка</span>
          </button>
        )}
        <button onClick={onHelp} title="Как пользоваться">
          <CircleHelp size={22} />
          <span>Помощь</span>
        </button>
        {user && !local && (
          <form action="/auth/logout" method="post">
            <button title="Выйти">
              <LogOut size={20} />
              <span>Выйти</span>
            </button>
          </form>
        )}
      </div>
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
  title,
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
  title: string;
}) {
  const [open, setOpen] = useState(false),
    ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
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
  }, []);
  const matches = query.trim()
    ? people.filter((p) => matchesPerson(p, query)).slice(0, 8)
    : [];
  return (
    <header className="archive-header">
      <div className="archive-title">
        <span>СЕМЕЙНЫЙ АРХИВ</span>
        <strong>{title || "История семьи"}</strong>
      </div>
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
            if (e.key === "Escape") setOpen(false);
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
