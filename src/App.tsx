"use client";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable graph region needs keyboard focus for arrow-key navigation. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Heart,
  MapPin,
  Maximize2,
  Menu,
  ImagePlus,
  ShieldCheck,
  Minus,
  Plus,
  Search,
  Sprout,
  TreeDeciduous,
  Users,
  X,
} from "lucide-react";
import {
  analyzeKinship,
  owns,
  ROLE_NAMES,
  centuryLabel,
  dateYear,
  END_YEAR,
  ERAS,
  fullName,
  NODE_HEIGHT,
  NODE_WIDTH,
  plural,
  graphLayout,
  RAIL_WIDTH,
  START_YEAR as DEFAULT_START_YEAR,
  yearY as baseYearY,
  yearAtY,
  years,
  type Person,
} from "./domain";

import { PersonPanel, Avatar } from "./components/person-panel";
import { ComparisonPanel } from "./components/comparison-panel";
import { useArchive } from "./hooks/useArchive";
import { LoginDialog } from "./components/login-dialog";
import { AdminPanel } from "./components/admin-panel";
import { FamiliesCatalog } from "./components/families-catalog";
import { ArchiveSettings } from "./components/archive-settings";
import { PersonEditor, ConnectionEditor } from "./components/archive-editors";
import { Gallery, PhotoViewer } from "./components/gallery";
import { PhotoUpload } from "./components/photo-upload";
import { Connections } from "./components/graph-connections";
const normalize = (text: string) =>
  text.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();

export default function App() {
  const {
    family,
    error,
    canEdit,
    user,
    readTree,
    readPhotos,
    local,
    busy,
    save,
    upload,
    reload,
    needsLogin,
    reverseTimeline,
  } = useArchive();
  const isAdmin = user?.role === "admin";
  const [adminPanel, setAdminRoute] = useState(
    window.location.pathname.startsWith("/admin"),
  );
  function setAdminPanel(open: boolean) {
    window.history.pushState(null, "", open ? "/admin" : "/");
    setAdminRoute(open);
    setMenuOpen(false);
  }
  useEffect(() => {
    const sync = () =>
      setAdminRoute(window.location.pathname.startsWith("/admin"));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false),
    [addOpen, setAddOpen] = useState(false);
  const [photoUpload, setPhotoUpload] = useState(false);
  const [relativeTo, setRelativeTo] = useState<Person | undefined>();
  const [login, setLogin] = useState(false);
  const [settings, setSettings] = useState(false);
  const [editor, setEditor] = useState<Person | "new" | null>(null);
  const [connection, setConnection] = useState<string[] | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [photoFilter, setPhotoFilter] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [resumePhoto, setResumePhoto] = useState<string | null>(null),
    [photoPersonId, setPhotoPersonId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [requestedView, setView] = useState<
    "tree" | "list" | "gallery" | "families"
  >("tree");
  const view = !readTree
    ? "gallery"
    : !readPhotos && requestedView === "gallery"
      ? "tree"
      : requestedView;
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [zoom, setZoom] = useState(0.9);
  const [scrollY, setScrollY] = useState(0);
  const [about, setAbout] = useState(false);
  const [lifelines, setLifelines] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const suppressGraphClick = useRef(false);
  const pendingReveal = useRef<string | null>(null);
  const people = useMemo(() => family?.people || [], [family]);
  const START_YEAR = Math.min(
    DEFAULT_START_YEAR,
    ...people
      .filter((p) => p.birth)
      .map((p) => Math.floor(dateYear(p.birth) / 10) * 10),
  );
  const layout = useMemo(
    () => graphLayout(people, START_YEAR, reverseTimeline),
    [people, START_YEAR, reverseTimeline],
  );
  const yearY = (year: number) =>
    layout.offset + baseYearY(year, START_YEAR, reverseTimeline);
  const position = useCallback(
    (p: Person) => layout.positions.get(p.id)!,
    [layout],
  );
  const WORLD_HEIGHT = baseYearY(END_YEAR, START_YEAR) + 140 + layout.offset;
  useEffect(() => {
    viewport.current?.scrollTo({ top: 0 });
  }, [reverseTimeline, START_YEAR]);
  const personMap = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );
  const chosen = selected
    .map((id) => personMap.get(id))
    .filter((p): p is Person => !!p);
  const relation = useMemo(
    () =>
      selected.length === 2 &&
      personMap.has(selected[0]) &&
      personMap.has(selected[1])
        ? analyzeKinship(
            personMap.get(selected[0])!,
            personMap.get(selected[1])!,
            people,
            family?.links,
          )
        : null,
    [selected, personMap, people, family?.links],
  );
  const highlighted = useMemo(() => relation?.path || [], [relation]);
  const width = Math.max(
    1090,
    ...people.map((p) => position(p).x + NODE_WIDTH + 60),
  );
  const searchResults = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return people
      .filter((p) =>
        terms.every((t) =>
          normalize(
            `${fullName(p)} ${p.maidenName || ""} ${p.birthPlace} ${p.deathPlace || ""} ${years(p)}`,
          ).includes(t),
        ),
      )
      .sort((a, b) => (a.birth || "9999").localeCompare(b.birth || "9999"));
  }, [people, query]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const typing =
        event.target instanceof HTMLElement &&
        !!event.target.closest("input,textarea,select,[contenteditable]");
      if (event.key === "/" && !typing && !about) {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if (event.key === "Escape") {
        setMenuOpen(false);
        setAddOpen(false);
        setSearchOpen(false);
        if (about) setAbout(false);
        else if (!typing) {
          setSelected([]);
          setCompare(false);
        } else searchInput.current?.blur();
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [about]);
  useEffect(() => {
    if (about) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [about]);

  const reveal = useCallback(
    (ids: string[], fit = false) => {
      setView("tree");
      const nodes = ids
        .map((id) => personMap.get(id))
        .filter((p): p is Person => !!p);
      if (!nodes.length) return;
      requestAnimationFrame(() => {
        const el = viewport.current;
        if (!el) return;
        const minX = Math.min(...nodes.map((p) => position(p).x)),
          maxX = Math.max(...nodes.map((p) => position(p).x + NODE_WIDTH));
        const minY = Math.min(...nodes.map((p) => position(p).y)),
          maxY = Math.max(...nodes.map((p) => position(p).y + NODE_HEIGHT));
        const nextZoom = fit
          ? Math.max(
              0.45,
              Math.min(
                1,
                (el.clientWidth - RAIL_WIDTH - 60) / (maxX - minX),
                (el.clientHeight - 100) / (maxY - minY),
              ),
            )
          : zoom;
        if (fit) setZoom(nextZoom);
        requestAnimationFrame(() =>
          el.scrollTo({
            left: Math.max(
              0,
              ((minX + maxX) * nextZoom) / 2 -
                (el.clientWidth - RAIL_WIDTH) / 2,
            ),
            top: Math.max(
              0,
              fit
                ? minY * nextZoom - 40
                : minY * nextZoom - el.clientHeight * 0.32,
            ),
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "instant"
              : "smooth",
          }),
        );
      });
    },
    [personMap, zoom, position],
  );
  useEffect(() => {
    const id = pendingReveal.current;
    if (id && personMap.has(id)) {
      pendingReveal.current = null;
      reveal([id]);
      panelRef.current?.scrollTo({ top: 0 });
    }
  }, [personMap, reveal, selected]);
  function choose(id: string, additive = false, move = false) {
    if (drag.current?.moved) return;
    if (linkFrom !== null) {
      if (!linkFrom) {
        setLinkFrom(id);
        setSelected([id]);
      } else if (linkFrom !== id) {
        setConnection([linkFrom, id]);
        setLinkFrom(null);
      }
      return;
    }
    if (compare || additive) {
      setCompare(true);
      setSelected((previous) =>
        previous.includes(id)
          ? previous.filter((p) => p !== id)
          : previous.length >= 2
            ? [previous[0], id]
            : [...previous, id],
      );
    } else setSelected([id]);
    setSearchOpen(false);
    if (move) reveal([id]);
    panelRef.current?.scrollTo({ top: 0 });
  }
  function chooseRelative(id: string) {
    setCompare(false);
    setSelected([id]);
    reveal([id]);
    panelRef.current?.scrollTo({ top: 0 });
  }
  function changeZoom(value: number) {
    const next = Math.min(1.35, Math.max(0.45, Math.round(value * 100) / 100));
    const el = viewport.current;
    const top = el ? (el.scrollTop + el.clientHeight / 2) / zoom : 0;
    const left = el
      ? (el.scrollLeft + (el.clientWidth - RAIL_WIDTH) / 2) / zoom
      : 0;
    setZoom(next);
    requestAnimationFrame(() => {
      if (el) {
        el.scrollTop = Math.max(0, top * next - el.clientHeight / 2);
        el.scrollLeft = Math.max(
          0,
          left * next - (el.clientWidth - RAIL_WIDTH) / 2,
        );
      }
    });
  }
  function fitTree() {
    const el = viewport.current;
    if (el) {
      setZoom(
        Math.max(0.45, Math.min(1, (el.clientWidth - RAIL_WIDTH) / width)),
      );
      el.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    }
  }
  function jumpToYear(year: number) {
    viewport.current?.scrollTo({
      top: Math.max(0, yearY(year) * zoom - 40),
      behavior: "smooth",
    });
  }
  const currentYear = Math.max(
    START_YEAR,
    Math.min(
      END_YEAR,
      Math.round(
        yearAtY(scrollY / zoom - layout.offset, START_YEAR, reverseTimeline),
      ),
    ),
  );
  const activeEra =
    [...ERAS].reverse().find((e) => currentYear >= e.start) || ERAS[0];

  return (
    <div className="app-shell">
      {login && <LoginDialog onClose={() => setLogin(false)} />}
      {photoUpload && canEdit && (
        <PhotoUpload
          upload={upload}
          busy={busy}
          onClose={() => setPhotoUpload(false)}
          onUploaded={(id) => {
            setPhotoId(id);
            setView("gallery");
            setPhotoFilter(null);
            setSelected([]);
          }}
        />
      )}
      {settings && family && isAdmin && (
        <ArchiveSettings
          family={family}
          save={save}
          busy={busy}
          onClose={() => setSettings(false)}
        />
      )}
      {family && editor && (
        <PersonEditor
          isAdmin={isAdmin}
          family={family}
          person={editor === "new" ? undefined : editor}
          user={user}
          relativeTo={relativeTo}
          upload={upload}
          save={save}
          busy={busy}
          onClose={() => {
            setEditor(null);
            setRelativeTo(undefined);
            if (resumePhoto) {
              setPhotoId(resumePhoto);
              setResumePhoto(null);
            }
          }}
          onSaved={(id) => {
            if (resumePhoto) setPhotoPersonId(id);
            else {
              pendingReveal.current = id;
              setCompare(false);
              setSelected([id]);
              setView("tree");
            }
          }}
        />
      )}
      {family && connection && (
        <ConnectionEditor
          user={user}
          family={family}
          initial={connection}
          save={save}
          busy={busy}
          onClose={() => setConnection(null)}
        />
      )}
      {family && photoId && family.photos?.find((p) => p.id === photoId) && (
        <PhotoViewer
          key={photoId}
          photo={family.photos.find((p) => p.id === photoId)!}
          family={family}
          initialPersonId={photoPersonId}
          onCreatePerson={() => {
            setResumePhoto(photoId);
            setPhotoId(null);
            setPhotoPersonId("");
            setRelativeTo(undefined);
            setEditor("new");
          }}
          canEdit={owns(
            user,
            family.photos.find((p) => p.id === photoId)!,
          )}
          canDelete={isAdmin}
          busy={busy}
          save={save}
          onClose={() => {
            setPhotoId(null);
            setPhotoPersonId("");
          }}
          onPerson={(id) => {
            setPhotoId(null);
            setPhotoPersonId("");
            chooseRelative(id);
          }}
        />
      )}
      {(menuOpen || addOpen) && (
        <button
          className="menu-backdrop"
          aria-label="Закрыть меню"
          onClick={() => {
            setMenuOpen(false);
            setAddOpen(false);
          }}
        />
      )}
      <header className="site-header compact-header">
        <button
          className="brand"
          aria-label="Древо — главная"
          onClick={() => {
            if (adminPanel) setAdminPanel(false);
            setView("tree");
            setSelected([]);
          }}
        >
          <TreeDeciduous size={30} strokeWidth={1.4} />
          древо<span className="brand-period">.</span>
        </button>
        <div className="header-menu">
          <button
            className="menu-trigger"
            aria-label="Разделы архива"
            aria-expanded={menuOpen}
            aria-controls="archive-menu"
            onClick={() => {
              setMenuOpen(!menuOpen);
              setAddOpen(false);
            }}
          >
            <Menu size={20} />
            <span>Меню</span>
          </button>
          {menuOpen && (
            <nav
              className="compact-menu"
              id="archive-menu"
              aria-label="Разделы архива"
            >
              <span className="menu-caption">СЕМЕЙНЫЙ АРХИВ</span>
              {(
                [
                  ["tree", "Древо", TreeDeciduous],
                  ["list", "Люди", Users],
                  ["families", "Семьи", Heart],
                  ["gallery", "Фотографии", ImagePlus],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  disabled={id === "gallery" ? !readPhotos : !readTree}
                  aria-current={!adminPanel && view === id ? "page" : undefined}
                  onClick={() => {
                    if (adminPanel) setAdminPanel(false);
                    setView(id);
                    setMenuOpen(false);
                    setPhotoFilter(null);
                    setSelected([]);
                  }}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
              {isAdmin && (
                <button onClick={() => setAdminPanel(true)}>
                  <ShieldCheck size={18} />
                  Админская панель
                </button>
              )}
              <button
                onClick={() => {
                  setAbout(true);
                  setMenuOpen(false);
                }}
              >
                <CircleHelp size={18} />
                Как пользоваться
              </button>
              {user && (
                <span className="menu-account">
                  {user.name}
                  <small>{ROLE_NAMES[user.role]}</small>
                </span>
              )}
            </nav>
          )}
        </div>
        {!adminPanel && (
          <>
            {" "}
            <div
              className="search-box"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget))
                  setSearchOpen(false);
              }}
            >
              <Search size={15} />
              <input
                ref={searchInput}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchResults[0] && query.trim()) {
                    choose(searchResults[0].id, e.shiftKey, true);
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Найти человека…"
                aria-label="Поиск по имени, месту или году"
                aria-controls="search-results"
                autoComplete="off"
              />
              {query ? (
                <button
                  aria-label="Очистить поиск"
                  onClick={() => {
                    setQuery("");
                    searchInput.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
              {searchOpen && query.trim() && view === "tree" && (
                <div className="search-results" id="search-results">
                  <div className="search-count">
                    Найдено: {searchResults.length}
                  </div>
                  {searchResults.length ? (
                    searchResults.slice(0, 8).map((p) => (
                      <button
                        key={p.id}
                        onClick={(e) => choose(p.id, e.shiftKey, true)}
                      >
                        <Avatar person={p} />
                        <span>
                          <b>{fullName(p)}</b>
                          <small>
                            {years(p)} · {p.birthPlace.split(",")[0]}
                          </small>
                        </span>
                        <ArrowUpRight size={12} />
                      </button>
                    ))
                  ) : (
                    <p>
                      Никого не нашли. Попробуйте другое имя, город или год.
                    </p>
                  )}
                  {searchResults.length > 8 && (
                    <button
                      className="all-results"
                      onClick={() => {
                        setView("list");
                        setSearchOpen(false);
                      }}
                    >
                      Все результаты
                      <ArrowRight size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        <div className="header-actions">
          {!adminPanel && readTree && people.length > 1 && (
            <button
              className={`header-compare ${compare ? "is-active" : ""}`}
              title="Сравнить родство"
              aria-label="Сравнить родство"
              aria-pressed={compare}
              onClick={() => {
                setCompare(!compare);
                setView("tree");
                if (compare) setSelected(selected.slice(0, 1));
              }}
            >
              <ArrowDownUp size={18} />
            </button>
          )}
          {!adminPanel && canEdit && (
            <div className="header-menu">
              <button
                className="primary-action add-trigger"
                disabled={busy}
                aria-expanded={addOpen}
                aria-controls="add-menu"
                onClick={() => {
                  setAddOpen(!addOpen);
                  setMenuOpen(false);
                }}
              >
                <Plus size={18} />
                <span>Добавить</span>
              </button>
              {addOpen && (
                <div className="compact-menu add-menu" id="add-menu">
                  <button
                    onClick={() => {
                      setRelativeTo(undefined);
                      setEditor("new");
                      setAddOpen(false);
                    }}
                  >
                    <Users size={18} />
                    <span>
                      Человека<small>Карточка и портрет</small>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setPhotoUpload(true);
                      setAddOpen(false);
                    }}
                  >
                    <ImagePlus size={18} />
                    <span>
                      Фотографию<small>Снимок, история и люди</small>
                    </span>
                  </button>
                  <button
                    disabled={people.length < 2}
                    onClick={() => {
                      setConnection(selected);
                      setAddOpen(false);
                    }}
                  >
                    <Plus size={18} />
                    Связь между людьми
                  </button>
                </div>
              )}
            </div>
          )}
          {!local &&
            (user ? (
              <button
                className="session-button"
                onClick={async () => {
                  await fetch("/auth/logout", { method: "POST" });
                  window.location.reload();
                }}
              >
                Выйти
              </button>
            ) : (
              <button className="session-button" onClick={() => setLogin(true)}>
                Войти
              </button>
            ))}
        </div>
      </header>
      {adminPanel ? (
        family && isAdmin ? (
          <AdminPanel
            family={family}
            onClose={() => setAdminPanel(false)}
            onChanged={reload}
            onSettings={() => setSettings(true)}
          />
        ) : (
          <main className="load-state">
            <ShieldCheck size={36} />
            <h2>Панель администратора</h2>
            <p>
              {user ? "Этот раздел доступен только администратору." : error}
            </p>
            <button
              className="primary-action"
              onClick={() => (user ? setAdminPanel(false) : setLogin(true))}
            >
              {user ? "Вернуться к древу" : "Войти через Яндекс"}
            </button>
          </main>
        )
      ) : (
        <main className="workspace">
          {linkFrom !== null && (
            <div className="floating-link-prompt">
              <span>Выберите человека на древе</span>
              <button
                onClick={() => {
                  setConnection(linkFrom ? [linkFrom] : []);
                  setLinkFrom(null);
                }}
              >
                Выбрать из списка
              </button>
              <button
                onClick={() => setLinkFrom(null)}
                aria-label="Отменить добавление связи"
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="workspace-body">
            {!family ? (
              <div className="load-state" role={error ? "alert" : "status"}>
                <TreeDeciduous size={42} strokeWidth={1} />
                <h2>
                  {needsLogin
                    ? "Семейная история — для своих"
                    : error
                      ? "Архив пока недоступен"
                      : "Собираем семейную историю"}
                </h2>
                <p>{error || "Загружаем людей и связи между поколениями…"}</p>
                {error && (
                  <button
                    className="full-button"
                    onClick={() => {
                      if (needsLogin) setLogin(true);
                      else reload();
                    }}
                  >
                    {needsLogin ? "Войти в архив" : "Попробовать снова"}
                  </button>
                )}
              </div>
            ) : (
              <>
                {people.length === 0 && view !== "gallery" ? (
                  <div className="empty-tree">
                    <div className="empty-tree-icon">
                      <TreeDeciduous size={64} strokeWidth={1} />
                    </div>
                    <span className="section-label">ВАША СЕМЕЙНАЯ ИСТОРИЯ</span>
                    <h1>Древо начинается с человека</h1>
                    <p>
                      Добавьте себя или близкого. Затем соедините поколения —
                      история будет расти вместе с вашей семьёй.
                    </p>
                    {canEdit && (
                      <button
                        className="primary-action"
                        onClick={() => {
                          setRelativeTo(undefined);
                          setEditor("new");
                        }}
                      >
                        <Plus size={18} />
                        Добавить первого человека
                      </button>
                    )}
                    <small>
                      Фотографии и источники можно добавить в любой момент.
                    </small>
                  </div>
                ) : view === "families" ? (
                  <FamiliesCatalog
                    people={people}
                    onPerson={chooseRelative}
                    onReveal={(ids) => {
                      setSelected([]);
                      setCompare(false);
                      reveal(ids, true);
                    }}
                  />
                ) : view === "gallery" ? (
                  <Gallery
                    personFilter={photoFilter}
                    onClearFilter={() => setPhotoFilter(null)}
                    family={family}
                    canEdit={canEdit}
                    onAdd={() => setPhotoUpload(true)}
                    onOpen={setPhotoId}
                  />
                ) : view === "tree" ? (
                  <div className="graph-area">
                    <div
                      ref={viewport}
                      className="graph-viewport"
                      tabIndex={0}
                      role="region"
                      aria-label="Генеалогическое древо. Прокручивайте для перемещения по времени. Shift и нажатие на карточку — сравнение."
                      onDragStart={(e) => e.preventDefault()}
                      onClickCapture={(e) => {
                        if (suppressGraphClick.current && e.detail > 0) {
                          e.preventDefault();
                          e.stopPropagation();
                          suppressGraphClick.current = false;
                        }
                      }}
                      onScroll={(e) => setScrollY(e.currentTarget.scrollTop)}
                      onPointerDown={(e) => {
                        suppressGraphClick.current = false;
                        if (
                          e.pointerType !== "mouse" ||
                          e.button !== 0 ||
                          (e.target as HTMLElement).closest(
                            "a,input,select,textarea",
                          )
                        )
                          return;
                        if (!(e.target as HTMLElement).closest("button"))
                          e.preventDefault();
                        drag.current = {
                          x: e.clientX,
                          y: e.clientY,
                          top: e.currentTarget.scrollTop,
                          left: e.currentTarget.scrollLeft,
                          moved: false,
                        };
                      }}
                      onPointerMove={(e) => {
                        if (!drag.current) return;
                        if (e.pointerType !== "mouse" || !(e.buttons & 1)) {
                          drag.current = null;
                          return;
                        }
                        const dx = e.clientX - drag.current.x,
                          dy = e.clientY - drag.current.y;
                        if (
                          !drag.current.moved &&
                          Math.abs(dx) + Math.abs(dy) <= 4
                        )
                          return;
                        drag.current.moved = true;
                        suppressGraphClick.current = true;
                        if (!e.currentTarget.hasPointerCapture(e.pointerId))
                          e.currentTarget.setPointerCapture(e.pointerId);
                        e.currentTarget.scrollLeft = drag.current.left - dx;
                        e.currentTarget.scrollTop = drag.current.top - dy;
                      }}
                      onPointerUp={(e) => {
                        if (e.currentTarget.hasPointerCapture(e.pointerId))
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        drag.current = null;
                      }}
                      onPointerCancel={() => {
                        drag.current = null;
                        suppressGraphClick.current = false;
                      }}
                      onLostPointerCapture={() => {
                        drag.current = null;
                      }}
                      onPointerLeave={(e) => {
                        if (!e.currentTarget.hasPointerCapture(e.pointerId))
                          drag.current = null;
                      }}
                    >
                      <div
                        className="graph-scroll-content"
                        style={{
                          width: RAIL_WIDTH + width * zoom,
                          height: WORLD_HEIGHT * zoom,
                        }}
                      >
                        <aside
                          className="era-rail"
                          aria-label="Исторические эпохи"
                          style={{ height: WORLD_HEIGHT * zoom }}
                        >
                          {layout.offset > 0 && (
                            <div
                              className="undated-era"
                              style={{ height: layout.offset * zoom }}
                            >
                              <span>ДАТЫ НЕ УКАЗАНЫ</span>
                            </div>
                          )}
                          {ERAS.filter(
                            (e) => e.end > START_YEAR && e.start < END_YEAR,
                          ).map((e) => {
                            const start = Math.max(START_YEAR, e.start),
                              end = Math.min(END_YEAR, e.end);
                            const top =
                                Math.min(yearY(start), yearY(end)) * zoom,
                              height =
                                Math.abs(yearY(end) - yearY(start)) * zoom;
                            return (
                              <div
                                key={e.name}
                                className={`era-section ${e.className}`}
                                style={{ top, height }}
                              >
                                <button
                                  className="era-label"
                                  style={{
                                    top: e.className === "transition" ? 4 : 85,
                                  }}
                                  onClick={() => jumpToYear(start)}
                                  title={`${e.name}, ${e.start}–${e.end === 2100 ? "настоящее время" : e.end}`}
                                >
                                  <span className="era-name">
                                    {e.className === "transition"
                                      ? "1917–1922"
                                      : e.name.toUpperCase()}
                                  </span>
                                  {e.className !== "transition" && (
                                    <span>
                                      {e.start} —{" "}
                                      {e.end === 2100 ? "н. в." : e.end}
                                    </span>
                                  )}
                                </button>
                              </div>
                            );
                          })}
                          {Array.from(
                            {
                              length:
                                Math.floor(END_YEAR / 100) -
                                Math.floor(START_YEAR / 100) +
                                1,
                            },
                            (_, i) => ({
                              name: centuryLabel(
                                Math.floor(START_YEAR / 100) + i + 1,
                              ),
                              year:
                                i === 0
                                  ? START_YEAR
                                  : (Math.floor(START_YEAR / 100) + i) * 100,
                            }),
                          ).map((c) => (
                            <button
                              className="century"
                              key={c.name}
                              style={{
                                top:
                                  yearY(
                                    reverseTimeline
                                      ? Math.min(
                                          END_YEAR,
                                          (Math.floor(c.year / 100) + 1) * 100,
                                        )
                                      : c.year,
                                  ) * zoom,
                              }}
                              onClick={() => jumpToYear(c.year)}
                              title={`Перейти в ${c.name} век`}
                            >
                              {c.name}
                              <span>ВЕК</span>
                            </button>
                          ))}
                        </aside>
                        <div className="world-position">
                          <div
                            className="timeline-stage"
                            style={{
                              width,
                              height: WORLD_HEIGHT,
                              transform: `scale(${zoom})`,
                            }}
                          >
                            {layout.offset > 0 && (
                              <div
                                className="undated-region"
                                style={{ height: layout.offset }}
                              >
                                <b>Без даты рождения</b>
                                <span>
                                  Эти карточки появятся на шкале эпох, когда вы
                                  укажете год.
                                </span>
                              </div>
                            )}
                            {ERAS.filter(
                              (e) => e.start > START_YEAR && e.start < END_YEAR,
                            ).map((e) => (
                              <div
                                className={`era-background ${e.className}`}
                                key={e.name}
                                style={{
                                  top: Math.min(
                                    yearY(e.start),
                                    yearY(Math.min(e.end, END_YEAR)),
                                  ),
                                  height: Math.abs(
                                    yearY(Math.min(e.end, END_YEAR)) -
                                      yearY(e.start),
                                  ),
                                }}
                              />
                            ))}
                            <div className="year-grid">
                              {Array.from(
                                {
                                  length:
                                    Math.floor((END_YEAR - START_YEAR) / 10) +
                                    1,
                                },
                                (_, i) => START_YEAR + i * 10,
                              ).map((year) => (
                                <div key={year} style={{ top: yearY(year) }}>
                                  <span>{year}</span>
                                </div>
                              ))}
                            </div>
                            <div
                              className="tree-caption"
                              style={{ top: layout.offset + 22 }}
                            >
                              <span className="tiny-dot" />
                              СЕМЬЯ В КОНТЕКСТЕ ВРЕМЕНИ
                            </div>
                            <Connections
                              positions={layout.positions}
                              startYear={START_YEAR}
                              reverse={reverseTimeline}
                              height={WORLD_HEIGHT}
                              links={family.links}
                              people={people}
                              highlighted={highlighted}
                              width={width}
                            />
                            {lifelines &&
                              chosen.length === 1 &&
                              !!chosen[0].birth &&
                              (() => {
                                const p = chosen[0],
                                  pos = position(p);
                                return (
                                  <div
                                    className="graph-lifeline"
                                    style={{
                                      left: pos.x - 13,
                                      top: Math.min(
                                        pos.y,
                                        yearY(dateYear(p.death)),
                                      ),
                                      height: Math.max(
                                        8,
                                        Math.abs(
                                          yearY(dateYear(p.death)) - pos.y,
                                        ),
                                      ),
                                    }}
                                  >
                                    <span>
                                      {reverseTimeline
                                        ? p.death
                                          ? dateYear(p.death)
                                          : "сегодня"
                                        : dateYear(p.birth)}
                                    </span>
                                    <span>
                                      {reverseTimeline
                                        ? dateYear(p.birth)
                                        : p.death
                                          ? dateYear(p.death)
                                          : "сегодня"}
                                    </span>
                                  </div>
                                );
                              })()}
                            {people.map((p) => {
                              const pos = position(p),
                                index = selected.indexOf(p.id),
                                faded =
                                  highlighted.length > 0 &&
                                  !highlighted.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  className={`person-node ${index >= 0 ? "selected" : ""} ${faded ? "dimmed" : ""} ${highlighted.includes(p.id) ? "on-path" : ""} ${query && !searchResults.includes(p) ? "search-dimmed" : ""}`}
                                  style={{
                                    left: pos.x,
                                    top: pos.y,
                                    width: NODE_WIDTH,
                                    height: NODE_HEIGHT,
                                  }}
                                  onClick={(e) =>
                                    choose(
                                      p.id,
                                      e.shiftKey || e.ctrlKey || e.metaKey,
                                    )
                                  }
                                  aria-pressed={index >= 0}
                                  aria-label={`${fullName(p)}, ${years(p)}. ${p.birthPlace}. Открыть карточку`}
                                >
                                  {index >= 0 && (
                                    <span className="selection-mark">
                                      {compare ? index + 1 : <Check size={9} />}
                                    </span>
                                  )}
                                  <span className="node-main">
                                    <Avatar person={p} />
                                    <span>
                                      <strong>{p.surname}</strong>
                                      <span className="person-given">
                                        {p.name} {p.patronymic}
                                      </span>
                                      {years(p) && (
                                        <span className="person-years">
                                          {years(p)}
                                          {p.birth && !p.death && (
                                            <i className="alive-dot" />
                                          )}
                                        </span>
                                      )}
                                    </span>
                                  </span>
                                  <span className="node-footer">
                                    <span>
                                      {p.birthPlace && (
                                        <>
                                          <MapPin size={10} />
                                          {p.birthPlace.split(",")[0]}
                                        </>
                                      )}
                                    </span>
                                    <span className="node-meta">
                                      {p.sources.length > 0 && (
                                        <>
                                          <FileText size={9} />
                                          {p.sources.length}
                                        </>
                                      )}
                                      <ArrowUpRight size={11} />
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                            <div
                              className="tree-end"
                              style={{ top: yearY(2029) }}
                            >
                              <Sprout size={18} strokeWidth={1.3} />
                              <span>История продолжается</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="graph-controls">
                      <div className="zoom-control">
                        <button
                          onClick={() => changeZoom(zoom - 0.1)}
                          disabled={zoom <= 0.45}
                          aria-label="Уменьшить масштаб"
                        >
                          <Minus size={14} />
                        </button>
                        <button
                          className="zoom-value"
                          onClick={() => changeZoom(1)}
                          title="Масштаб 100%"
                        >
                          {Math.round(zoom * 100)}%
                        </button>
                        <button
                          onClick={() => changeZoom(zoom + 0.1)}
                          disabled={zoom >= 1.35}
                          aria-label="Увеличить масштаб"
                        >
                          <Plus size={14} />
                        </button>
                        <i />
                        <button
                          onClick={fitTree}
                          title="Вписать древо по ширине"
                          aria-label="Вписать древо по ширине"
                        >
                          <Maximize2 size={13} />
                        </button>
                      </div>
                      <button
                        className={`lifeline-toggle ${lifelines ? "active" : ""}`}
                        onClick={() => setLifelines(!lifelines)}
                        aria-pressed={lifelines}
                        title="Показать полосу жизни выбранного человека"
                      >
                        <span className="lifeline-icon" />
                        Линия жизни
                      </button>
                    </div>
                    <div className={`current-era ${activeEra.className}`}>
                      <i style={{ background: activeEra.color }} />
                      <span>
                        {layout.offset > 0 && scrollY / zoom < layout.offset
                          ? "Без даты рождения"
                          : activeEra.short}
                      </span>
                      {!(
                        layout.offset > 0 && scrollY / zoom < layout.offset
                      ) && <b>{currentYear}</b>}
                    </div>
                    {compare && selected.length < 2 && (
                      <div className="graph-compare-hint" role="status">
                        <ArrowDownUp size={12} />
                        Выберите {selected.length ? "второго" : "двух"}{" "}
                        {selected.length ? "человека" : "людей"} на древе
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="people-list">
                    <div className="list-heading">
                      <h2>Люди в нашей истории</h2>
                      <span>
                        {searchResults.length}{" "}
                        {plural(
                          searchResults.length,
                          "человек",
                          "человека",
                          "человек",
                        )}
                      </span>
                    </div>
                    <div className="list-columns">
                      <span>Человек</span>
                      <span>Годы жизни</span>
                      <span>Место рождения</span>
                    </div>
                    {searchResults.map((p) => (
                      <button
                        key={p.id}
                        className={`person-row ${selected.includes(p.id) ? "active" : ""}`}
                        onClick={(e) =>
                          choose(p.id, e.shiftKey || e.ctrlKey || e.metaKey)
                        }
                        aria-pressed={selected.includes(p.id)}
                      >
                        <span className="list-person">
                          <Avatar person={p} />
                          <span>
                            <b>{p.surname}</b>
                            <small>
                              {p.name} {p.patronymic}
                            </small>
                          </span>
                        </span>
                        <span>{years(p)}</span>
                        <span>
                          {p.birthPlace.split(",")[0]}
                          <ChevronRight size={13} />
                        </span>
                      </button>
                    ))}
                    {!searchResults.length && (
                      <div className="empty-sources">
                        <Search size={25} />
                        <h3>Совпадений нет</h3>
                        <p>Попробуйте другое имя, город или год.</p>
                        <button
                          className="full-button"
                          onClick={() => setQuery("")}
                        >
                          Сбросить поиск
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {(chosen.length > 0 || compare) && (
                  <aside
                    className={`detail-panel ${compare && chosen.length < 2 ? "picking" : ""}`}
                    ref={panelRef}
                    aria-label={
                      compare ? "Анализ родства" : "Карточка человека"
                    }
                  >
                    <div className="panel-topline">
                      <span>
                        {compare ? "АНАЛИЗ РОДСТВА" : "КАРТОЧКА ЧЕЛОВЕКА"}
                      </span>
                      <button
                        aria-label="Закрыть карточку"
                        onClick={() => {
                          setSelected([]);
                          setCompare(false);
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {compare ? (
                      <ComparisonPanel
                        links={family.links}
                        selected={chosen}
                        relation={relation}
                        people={people}
                        onRemove={(id) =>
                          setSelected(selected.filter((p) => p !== id))
                        }
                        onReveal={() => {
                          setQuery("");
                          reveal(relation?.path || [], true);
                        }}
                      />
                    ) : (
                      chosen[0] && (
                        <>
                          <div className="person-edit-actions">
                            {canEdit && (
                              <button
                                onClick={() => {
                                  setRelativeTo(chosen[0]);
                                  setEditor("new");
                                }}
                              >
                                Добавить родственника
                              </button>
                            )}
                            {owns(user, chosen[0]) && (
                              <>
                                <button onClick={() => setEditor(chosen[0])}>
                                  Редактировать
                                </button>
                                <button
                                  onClick={() => {
                                    setLinkFrom(chosen[0].id);
                                    setSelected([]);
                                    setView("tree");
                                  }}
                                >
                                  Добавить связь
                                </button>
                              </>
                            )}
                          </div>
                          <PersonPanel
                            links={family.links}
                            key={chosen[0].id}
                            person={chosen[0]}
                            people={people}
                            onSelect={chooseRelative}
                            onCompare={() => setCompare(true)}
                          />
                          <section className="person-photos">
                            {readPhotos && (
                              <button
                                className="full-button"
                                onClick={() => {
                                  setPhotoFilter(chosen[0].id);
                                  setView("gallery");
                                  setSelected([]);
                                }}
                              >
                                {"Фотоальбом"} (
                                {family.photos?.filter((p) =>
                                  p.tags.some(
                                    (t) => t.personId === chosen[0].id,
                                  ),
                                ).length || 0}
                                )
                              </button>
                            )}
                            <h3>На фотографиях</h3>
                            {family.photos?.some((p) =>
                              p.tags.some((t) => t.personId === chosen[0].id),
                            ) ? (
                              <div className="person-photo-grid">
                                {family.photos
                                  .filter((p) =>
                                    p.tags.some(
                                      (t) => t.personId === chosen[0].id,
                                    ),
                                  )
                                  .map((p) => (
                                    <button
                                      key={p.id}
                                      onClick={() => setPhotoId(p.id)}
                                    >
                                      <img src={p.url} alt={p.title} />
                                      <span>{p.title}</span>
                                    </button>
                                  ))}
                              </div>
                            ) : (
                              <p>
                                Отметьте этого человека на снимке в галерее.
                              </p>
                            )}
                          </section>
                        </>
                      )
                    )}
                  </aside>
                )}
              </>
            )}
          </div>
        </main>
      )}
      <dialog
        ref={dialogRef}
        className="about-dialog"
        aria-labelledby="about-title"
        onCancel={() => setAbout(false)}
      >
        <button
          className="dialog-close"
          onClick={() => setAbout(false)}
          aria-label="Закрыть справку"
        >
          <X size={19} />
        </button>
        <TreeDeciduous size={37} strokeWidth={1.2} />
        <div className="eyebrow">МЕСТО ДЛЯ СЕМЕЙНОЙ ПАМЯТИ</div>
        <h2 id="about-title">
          История начинается
          <br />с семьи<span>.</span>
        </h2>
        <p>«Древо» соединяет людей, события и эпохи в одну семейную историю.</p>
        <div className="about-instructions">
          <div>
            <TreeDeciduous size={18} />
            <span>
              <b>Путешествуйте во времени</b>
              <p>
                Прокручивайте древо вверх и вниз. Карточки расположены по году
                рождения. Слева — века и исторические эпохи.
              </p>
            </span>
          </div>
          <div>
            <BookOpen size={18} />
            <span>
              <b>Открывайте истории</b>
              <p>
                Нажмите на человека: справа появятся даты, места, фотография при
                наличии и ссылки на источники. Линия жизни показывает годы от
                рождения до смерти или сегодняшнего дня.
              </p>
            </span>
          </div>
          <div>
            <Users size={18} />
            <span>
              <b>Находите общее</b>
              <p>
                Включите «Сравнить родство» и выберите двух людей. Или
                удерживайте Shift при выборе второго человека.
              </p>
            </span>
          </div>
        </div>
        <div className="about-demo">
          <Heart size={16} />
          <p>
            {family?.demo !== false
              ? "Это демонстрационная семья. Все имена, биографии и записи вымышлены и служат примером оформления архива."
              : "Семейная история составлена из сведений и связей, добавленных в архив."}
          </p>
        </div>
        <button className="dialog-done" onClick={() => setAbout(false)}>
          Перейти к истории
          <ArrowRight size={14} />
        </button>
      </dialog>
    </div>
  );
}
