import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  TreeDeciduous,
  Users,
  Image,
  BookOpenText,
  Heart,
  ShieldCheck,
  LogOut,
  CircleHelp,
  Menu,
  MapPin,
  ChartNoAxesCombined,
  LibraryBig,
  Settings2,
} from "lucide-react";
import { safeUrl, type Person, type ArchiveUser } from "../domain";
import { mediaPreview } from "../domain/media-preview";
import { archivePaths, type ArchiveView } from "../domain/archive-routes";
import { clearLayoutStorage } from "./tree/layout-storage";
import { TreeSearch } from "./tree-search";
export type { ArchiveView } from "../domain/archive-routes";
export function ArchiveNavigation({
  view,
  onView,
  user,
  accountPerson,
  local,
  readTree,
  readPhotos,
  onHelp,
  onTreePreferences,
}: {
  view: ArchiveView;
  onView: (view: ArchiveView) => void;
  user: ArchiveUser | null;
  accountPerson?: Person;
  local: boolean;
  readTree: boolean;
  readPhotos: boolean;
  onHelp: () => void;
  onTreePreferences: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [failedPortrait, setFailedPortrait] = useState<string>();
  const portrait = mediaPreview(safeUrl(accountPerson?.photo));
  const initial = user?.name.trim().charAt(0).toLocaleUpperCase("ru-RU") || "Д";
  const navigate = (
    event: MouseEvent<HTMLAnchorElement>,
    next: ArchiveView,
  ) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (menu.current) menu.current.open = false;
    onView(next);
  };
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
  const logout = async () => {
    if (menu.current) menu.current.open = false;
    try {
      const response = await fetch("/auth/logout", { method: "POST" });
      if (!response.ok) {
        window.location.reload();
        return;
      }
      await clearLayoutStorage();
      window.location.replace("/");
    } catch {
      window.location.reload();
    }
  };
  return (
    <nav className="archive-nav" aria-label="Разделы архива">
      <a
        className="nav-brand"
        href={archivePaths.tree}
        onClick={(event) => navigate(event, "tree")}
        aria-label="Древо"
      >
        <TreeDeciduous size={32} strokeWidth={1.5} />
        <span>древо.</span>
      </a>
      <div className="nav-sections">
        {(
          [
            ["tree", "Древо", TreeDeciduous],
            ["list", "Люди", Users],
            ["families", "Семьи", Heart],
            ["gallery", "Фото", Image],
            ["documents", "Документы", BookOpenText],
            ["places", "Места", MapPin],
            ["insights", "Сводка", ChartNoAxesCombined],
            ["resources", "Ресурсы", LibraryBig],
          ] as const
        )
          .filter(([id]) =>
            id === "gallery"
              ? readPhotos
              : id === "documents"
                ? user?.approved === true || local
                : id === "places"
                  ? readTree || readPhotos
                  : readTree,
          )
          .map(([id, label, Icon]) => (
            <a
              key={id}
              href={archivePaths[id]}
              aria-current={view === id ? "page" : undefined}
              onClick={(event) => navigate(event, id)}
            >
              <Icon size={22} strokeWidth={1.5} />
              <span>{label}</span>
            </a>
          ))}
      </div>
      {user && (
        <a
          className="nav-account"
          href={archivePaths.account}
          aria-label={`Личный кабинет: ${user.name}`}
          aria-current={view === "account" ? "page" : undefined}
          onClick={(event) => navigate(event, "account")}
          title="Личный кабинет"
        >
          <span className="nav-account-avatar" aria-hidden="true">
            {portrait && portrait !== failedPortrait ? (
              <img
                src={portrait}
                alt=""
                onError={() => setFailedPortrait(portrait)}
              />
            ) : (
              initial
            )}
          </span>
        </a>
      )}
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
                ["documents", "Документы", BookOpenText],
                ["places", "Места", MapPin],
                ["insights", "Сводка", ChartNoAxesCombined],
                ["resources", "Ресурсы", LibraryBig],
              ] as const
            )
              .filter(([id]) =>
                id === "gallery"
                  ? readPhotos
                  : id === "documents"
                    ? user?.approved === true || local
                    : id === "places"
                      ? readTree || readPhotos
                      : readTree,
              )
              .map(([id, label, Icon]) => (
                <a
                  key={id}
                  href={archivePaths[id]}
                  aria-current={view === id ? "page" : undefined}
                  onClick={(event) => navigate(event, id)}
                >
                  <Icon size={18} />
                  {label}
                </a>
              ))}
          </div>
          {user?.approved && readTree && (
            <button
              onClick={() => {
                if (menu.current) menu.current.open = false;
                onTreePreferences();
              }}
              title="Моё древо"
            >
              <Settings2 size={18} />
              <span>Моё древо</span>
            </button>
          )}
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
          {user?.role === "admin" && (
            <a
              href={archivePaths.admin}
              aria-current={view === "admin" ? "page" : undefined}
              onClick={(event) => navigate(event, "admin")}
              title="Админская панель"
            >
              <ShieldCheck size={22} />
              <span>Админка</span>
            </a>
          )}
          {user && !local && (
            <button title="Выйти" onClick={() => void logout()}>
              <LogOut size={20} />
              <span>Выйти</span>
            </button>
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
  busy,
  onLogin,
  user,
  navigation,
}: {
  people: Person[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  busy: boolean;
  onLogin: () => void;
  user: ArchiveUser | null;
  navigation: ReactNode;
}) {
  return (
    <header className="archive-header">
      {navigation}
      <TreeSearch
        people={people}
        query={query}
        onQuery={onQuery}
        onSelect={onSelect}
      />
      <div className="archive-header-actions">
        {busy && <span role="status">Сохраняем…</span>}
        {!user && (
          <button className="login-action" onClick={onLogin}>
            Войти
          </button>
        )}
      </div>
    </header>
  );
}
