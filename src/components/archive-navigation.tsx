import { archiveFetch } from "../data/archive-fetch.ts";
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
  UserRound,
  Image,
  BookOpenText,
  Heart,
  ShieldCheck,
  LogOut,
  MapPin,
  ChartNoAxesCombined,
  LibraryBig,
  Info,
} from "lucide-react";
import { isArchiveOwner, safeUrl, type Person, type ArchiveUser } from "../domain";
import { mediaPreview } from "../domain/media-preview";
import { archivePaths, type ArchiveView } from "../domain/archive-routes";
import { scopedArchivePath } from "../domain/archive-context.ts";
import { clearLayoutStorage } from "./tree/layout-storage";
import { TreeSearch } from "./tree-search";
export type { ArchiveView } from "../domain/archive-routes";
export function ArchiveNavigation({
  view,
  onView,
  user,
  account,
  accountPerson,
  local,
  readTree,
  readPhotos,
  onHelp,
  onPlatformLeave,
}: {
  view: ArchiveView;
  onView: (view: ArchiveView) => void;
  user: ArchiveUser | null;
  account?: { id: string; name: string; globalRole?: "admin" | "researcher" | null } | null;
  accountPerson?: Person;
  local: boolean;
  readTree: boolean;
  readPhotos: boolean;
  onHelp: () => void;
  onPlatformLeave?: () => boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [failedPortrait, setFailedPortrait] = useState<string>();
  const portrait = mediaPreview(safeUrl(accountPerson?.photo));
  const identity = user || account;
  const initial =
    identity?.name.trim().charAt(0).toLocaleUpperCase("ru-RU") || "Д";
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
    if (menu.current) {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
    onView(next);
  };
  const checkPlatformLeave = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button === 0 && !event.ctrlKey && !event.metaKey &&
        !event.shiftKey && !event.altKey && onPlatformLeave && !onPlatformLeave())
      event.preventDefault();
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
      const response = await archiveFetch("/auth/logout", { method: "POST" });
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
  const showAbout = () => {
    if (menu.current?.open) {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
    onHelp();
  };
  return (
    <nav className="archive-nav" aria-label="Разделы архива">
      <a
        className="nav-brand"
        href={scopedArchivePath(archivePaths.tree)}
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
              href={scopedArchivePath(archivePaths[id])}
              aria-current={view === id ? "page" : undefined}
              onClick={(event) => navigate(event, id)}
            >
              <Icon size={22} strokeWidth={1.5} />
              <span>{label}</span>
            </a>
          ))}
      </div>
      <button
        className="nav-about"
        type="button"
        onClick={showAbout}
      >
        О проекте
      </button>
      <details ref={menu} className="archive-more" key={view}>
        <summary className="nav-account" aria-label="Меню проекта"
          title={identity ? `Меню: ${identity.name}` : "Меню проекта"}>
          <span className="nav-account-avatar" aria-hidden="true">
            {portrait && portrait !== failedPortrait ? (
              <img src={portrait} alt="" onError={() => setFailedPortrait(portrait)} />
            ) : identity ? initial : <UserRound size={20} />}
          </span>
        </summary>
        <div className="nav-bottom">
          <a className="nav-menu-account" href={scopedArchivePath(archivePaths.account)}
            aria-current={view === "account" ? "page" : undefined}
            onClick={(event) => navigate(event, "account")}>
            <UserRound size={18} aria-hidden="true" />
            <span>Личный кабинет</span>
          </a>
          {user && isArchiveOwner(user) && user.approved === true && (
            <a
              className="nav-menu-manage"
              href={scopedArchivePath(archivePaths.manage)}
              aria-current={view === "manage" ? "page" : undefined}
              onClick={(event) => navigate(event, "manage")}
            >
              <ShieldCheck size={22} />
              <span>Управление деревом</span>
            </a>
          )}
          {(account?.globalRole === "admin" || user?.globalRole === "admin" || user?.platformAdmin === true) && (
            <a className="nav-menu-platform" href="/admin"
              aria-current={view === "admin" ? "page" : undefined}
              onClick={checkPlatformLeave}>
              <ShieldCheck size={22} />
              <span>Админка платформы</span>
            </a>
          )}
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
                  href={scopedArchivePath(archivePaths[id])}
                  aria-current={view === id ? "page" : undefined}
                  onClick={(event) => navigate(event, id)}
                >
                  <Icon size={18} />
                  {label}
                </a>
              ))}
          </div>
          <button className="nav-about-menu" type="button" onClick={showAbout}>
            <Info size={18} aria-hidden="true" />
            <span>О проекте</span>
          </button>
          <a href="/discover">
            <Users size={18} />
            <span>Поиск опубликованных людей</span>
          </a>
          {identity && !local && (
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
  onSelectDocument,
  busy,
  navigation,
}: {
  people: Person[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onSelectDocument?: (id: string) => void;
  busy: boolean;
  navigation: ReactNode;
}) {
  return (
    <header className="archive-header">
      {navigation}
      <TreeSearch
        globalSearch
        people={people}
        query={query}
        onQuery={onQuery}
        onSelect={onSelect}
        onSelectDocument={onSelectDocument}
      />
      <div className="archive-header-actions">
        {busy && <span role="status">Сохраняем…</span>}
      </div>
    </header>
  );
}
