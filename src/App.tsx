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
  List,
  MapPin,
  Maximize2,
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
  centuryLabel,
  dateYear,
  END_YEAR,
  ERAS,
  fullName,
  NODE_HEIGHT,
  NODE_WIDTH,
  plural,
  position as basePosition,
  RAIL_WIDTH,
  START_YEAR as DEFAULT_START_YEAR,
  YEAR_HEIGHT,
  yearY as baseYearY,
  years,
  type Person,
} from "./domain";

import { PersonPanel, Avatar } from "./components/person-panel";
import { ComparisonPanel } from "./components/comparison-panel";
import { useArchive } from "./hooks/useArchive";
import { LoginDialog } from "./components/login-dialog";
import { ArchiveSettings } from "./components/archive-settings";
import { PersonEditor, ConnectionEditor } from "./components/archive-editors";
import { Gallery, PhotoViewer } from "./components/gallery";
import { Connections } from "./components/graph-connections";
const normalize = (text: string) =>
  text.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();

export default function App() {
  const { family, error, canEdit, local, busy, save, upload, reload } =
    useArchive();
  const [login, setLogin] = useState(false);
  const [settings, setSettings] = useState(false);
  const [editor, setEditor] = useState<Person | "new" | null>(null);
  const [connection, setConnection] = useState<string[] | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [view, setView] = useState<"tree" | "list" | "gallery">("tree");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [zoom, setZoom] = useState(0.9);
  const [currentYear, setCurrentYear] = useState(DEFAULT_START_YEAR);
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
  const people = useMemo(() => family?.people || [], [family]);
  const START_YEAR = Math.min(
    DEFAULT_START_YEAR,
    ...people.map((p) => Math.floor(dateYear(p.birth) / 10) * 10),
  );
  const yearY = (year: number) => baseYearY(year, START_YEAR);
  const position = useCallback(
    (p: Person) => basePosition(p, START_YEAR),
    [START_YEAR],
  );
  const WORLD_HEIGHT = yearY(END_YEAR) + 140;
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
      .sort((a, b) => a.birth.localeCompare(b.birth));
  }, [people, query]);
  const generationCount = Math.max(0, ...people.map((p) => p.generation));
  const firstYear = people.length
    ? Math.min(...people.map((p) => dateYear(p.birth)))
    : 1838;
  const lastYear = people.length
    ? Math.max(...people.map((p) => dateYear(p.death)))
    : new Date().getFullYear();

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
  const activeEra =
    [...ERAS].reverse().find((e) => currentYear >= e.start) || ERAS[0];

  return (
    <div className="app-shell">
      {login && (
        <LoginDialog onClose={() => setLogin(false)} onLogin={reload} />
      )}
      {settings && family && (
        <ArchiveSettings
          family={family}
          save={save}
          busy={busy}
          onClose={() => setSettings(false)}
        />
      )}
      {family && editor && (
        <PersonEditor
          family={family}
          person={editor === "new" ? undefined : editor}
          save={save}
          busy={busy}
          onClose={() => setEditor(null)}
          onSaved={chooseRelative}
        />
      )}
      {family && connection && (
        <ConnectionEditor
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
          canEdit={canEdit}
          busy={busy}
          save={save}
          onClose={() => setPhotoId(null)}
          onPerson={(id) => {
            setPhotoId(null);
            chooseRelative(id);
          }}
        />
      )}
      <header className="site-header">
        <button
          className="brand"
          onClick={() => {
            setView("tree");
            setSelected([]);
            setCompare(false);
            setQuery("");
            fitTree();
          }}
          aria-label="Древо — главная"
        >
          <TreeDeciduous className="brand-symbol" size={32} strokeWidth={1.4} />
          древо<span className="brand-period">.</span>
        </button>
        <nav aria-label="Основная навигация">
          <button
            className={view === "tree" ? "nav-active" : ""}
            onClick={() => setView("tree")}
          >
            Семейное древо
          </button>
          <button
            className={view === "list" ? "nav-active" : ""}
            onClick={() => setView("list")}
          >
            Люди<span className="nav-count">{people.length || "—"}</span>
          </button>
          <button
            className={view === "gallery" ? "nav-active" : ""}
            onClick={() => setView("gallery")}
          >
            Фотографии
          </button>
          <button onClick={() => setAbout(true)}>
            Об архиве
            <ArrowUpRight size={11} />
          </button>
        </nav>
        <div className="header-right">
          {!local &&
            (canEdit ? (
              <button
                onClick={async () => {
                  await fetch("/auth/logout", { method: "POST" });
                  window.location.reload();
                }}
              >
                Выйти
              </button>
            ) : (
              <button onClick={() => setLogin(true)}>Войти</button>
            ))}
          <span className="private-tag">
            <span className="tiny-dot" />
            Семейный архив
          </span>
          <button
            className="owner-avatar"
            onClick={() => setAbout(true)}
            aria-label="О семейном архиве"
          >
            С
          </button>
        </div>
      </header>
      <section className="project-heading">
        <div>
          <div className="eyebrow">ИСТОРИЯ, КОТОРАЯ ПРОДОЛЖАЕТСЯ</div>
          <h1>
            {family?.title || "Семья Соколовых"}
            <span className="heading-dot">.</span>
          </h1>
          <p>
            {family?.description || "Одна семья. Много историй. Всё связано."}
          </p>
        </div>
        <div className="project-stats">
          <div>
            <b>{people.length || "—"}</b>
            <span>
              {plural(people.length, "человек", "человека", "человек")}
            </span>
          </div>
          <div>
            <b>{generationCount || "—"}</b>
            <span>
              {plural(generationCount, "поколение", "поколения", "поколений")}
            </span>
          </div>
          <div>
            <b>{people.length ? lastYear - firstYear : "—"}</b>
            <span>лет истории</span>
          </div>
        </div>
      </section>
      <main className="workspace">
        <div className="toolbar">
          <div className="view-switch" aria-label="Вид архива">
            <button
              className={view === "tree" ? "active" : ""}
              aria-pressed={view === "tree"}
              onClick={() => setView("tree")}
            >
              <TreeDeciduous size={13} />
              Древо
            </button>
            <button
              className={view === "list" ? "active" : ""}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={14} />
              Список
            </button>
          </div>
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
                  <p>Никого не нашли. Попробуйте другое имя, город или год.</p>
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
          <div className="toolbar-spacer" />
          <button
            className={`compare-button ${compare ? "is-active" : ""}`}
            aria-pressed={compare}
            aria-label={
              compare
                ? "Завершить сравнение родства"
                : "Сравнить родство двух людей"
            }
            title="Сравнить родство двух людей"
            onClick={() => {
              setCompare(!compare);
              if (compare) setSelected(selected.slice(0, 1));
            }}
          >
            <ArrowDownUp size={13} />
            <span>{compare ? "Режим сравнения" : "Сравнить родство"}</span>
            {compare && (
              <span className="compare-count">{selected.length}/2</span>
            )}
          </button>
          <button
            className="help-button"
            onClick={() => setAbout(true)}
            aria-label="Как пользоваться древом"
          >
            <CircleHelp size={16} />
          </button>
        </div>
        {family && (
          <div className="archive-actions">
            <button onClick={() => setView("gallery")}>
              Фотографии <span>{family.photos?.length || 0}</span>
            </button>
            {canEdit && (
              <>
                <button disabled={busy} onClick={() => setEditor("new")}>
                  <Plus size={14} /> Человек
                </button>
                <button
                  disabled={busy || people.length < 2}
                  onClick={() => {
                    if (chosen.length === 2) setConnection(selected);
                    else {
                      setView("tree");
                      setCompare(false);
                      setLinkFrom(chosen[0]?.id || "");
                    }
                  }}
                >
                  Связать людей
                </button>
                <button onClick={() => setSettings(true)}>{"Настройки"}</button>
                <a href="/api/backup" download>
                  {"Бэкап базы"}
                </a>
                <a href="/api/export" download>
                  Экспорт
                </a>
              </>
            )}
            <span className="save-status" role="status">
              {busy
                ? "Сохраняем…"
                : canEdit
                  ? "Сохранено в архиве"
                  : "Просмотр архива"}
            </span>
            {linkFrom !== null && (
              <div className="link-prompt">
                {linkFrom
                  ? "Выберите второго человека на древе"
                  : "Выберите первого человека на древе"}
                <button onClick={() => setLinkFrom(null)}>Отмена</button>
                <button
                  onClick={() => {
                    setConnection(linkFrom ? [linkFrom] : []);
                    setLinkFrom(null);
                  }}
                >
                  Выбрать из списка
                </button>
              </div>
            )}
          </div>
        )}
        <div className="workspace-body">
          {!family ? (
            <div className="load-state" role={error ? "alert" : "status"}>
              <TreeDeciduous size={42} strokeWidth={1} />
              <h2>
                {error ? "Архив пока недоступен" : "Собираем семейную историю"}
              </h2>
              <p>{error || "Загружаем людей и связи между поколениями…"}</p>
              {error && (
                <button
                  className="full-button"
                  onClick={() => {
                    reload();
                  }}
                >
                  Попробовать снова
                </button>
              )}
            </div>
          ) : (
            <>
              {view === "gallery" ? (
                <Gallery
                  family={family}
                  canEdit={canEdit}
                  busy={busy}
                  upload={upload}
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
                    onScroll={(e) =>
                      setCurrentYear(
                        Math.max(
                          START_YEAR,
                          Math.min(
                            END_YEAR,
                            Math.round(
                              START_YEAR +
                                (e.currentTarget.scrollTop / zoom - 60) /
                                  YEAR_HEIGHT,
                            ),
                          ),
                        ),
                      )
                    }
                    onPointerDown={(e) => {
                      if (
                        e.pointerType !== "mouse" ||
                        e.button !== 0 ||
                        (e.target as HTMLElement).closest("button,a,input")
                      )
                        return;
                      drag.current = {
                        x: e.clientX,
                        y: e.clientY,
                        top: e.currentTarget.scrollTop,
                        left: e.currentTarget.scrollLeft,
                        moved: false,
                      };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (!drag.current) return;
                      const dx = e.clientX - drag.current.x,
                        dy = e.clientY - drag.current.y;
                      if (Math.abs(dx) + Math.abs(dy) > 4)
                        drag.current.moved = true;
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
                        {ERAS.filter(
                          (e) => e.end > START_YEAR && e.start < END_YEAR,
                        ).map((e) => {
                          const start = Math.max(START_YEAR, e.start),
                            end = Math.min(END_YEAR, e.end);
                          const top =
                              e.start < START_YEAR ? 0 : yearY(start) * zoom,
                            height = yearY(end) * zoom - top;
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
                                (c.year === START_YEAR ? 0 : yearY(c.year)) *
                                zoom,
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
                          {ERAS.filter(
                            (e) => e.start > START_YEAR && e.start < END_YEAR,
                          ).map((e) => (
                            <div
                              className={`era-background ${e.className}`}
                              key={e.name}
                              style={{
                                top: yearY(e.start),
                                height:
                                  yearY(Math.min(e.end, END_YEAR)) -
                                  yearY(e.start),
                              }}
                            />
                          ))}
                          <div className="year-grid">
                            {Array.from(
                              {
                                length:
                                  Math.floor((END_YEAR - START_YEAR) / 10) + 1,
                              },
                              (_, i) => START_YEAR + i * 10,
                            ).map((year) => (
                              <div key={year} style={{ top: yearY(year) }}>
                                <span>{year}</span>
                              </div>
                            ))}
                          </div>
                          <div className="tree-caption">
                            <span className="tiny-dot" />
                            СЕМЬЯ В КОНТЕКСТЕ ВРЕМЕНИ
                          </div>
                          <Connections
                            startYear={START_YEAR}
                            height={WORLD_HEIGHT}
                            links={family.links}
                            people={people}
                            highlighted={highlighted}
                            width={width}
                          />
                          {lifelines &&
                            chosen.length === 1 &&
                            (() => {
                              const p = chosen[0],
                                pos = position(p);
                              return (
                                <div
                                  className="graph-lifeline"
                                  style={{
                                    left: pos.x - 13,
                                    top: pos.y,
                                    height: Math.max(
                                      8,
                                      yearY(dateYear(p.death)) - pos.y,
                                    ),
                                  }}
                                >
                                  <span>{dateYear(p.birth)}</span>
                                  <span>
                                    {p.death ? dateYear(p.death) : "сегодня"}
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
                                    <span className="person-years">
                                      {years(p)}
                                      {!p.death && <i className="alive-dot" />}
                                    </span>
                                  </span>
                                </span>
                                <span className="node-footer">
                                  <span>
                                    <MapPin size={10} />
                                    {p.birthPlace.split(",")[0]}
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
                    <span>{activeEra.short}</span>
                    <b>{currentYear}</b>
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
                  aria-label={compare ? "Анализ родства" : "Карточка человека"}
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
                            <p>Отметьте этого человека на снимке в галерее.</p>
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
        <footer className="workspace-footer">
          <span>
            <i className="tiny-dot" />
            {family?.demo ? "Демонстрационное древо" : "Семейное древо"}
          </span>
          <span className="graph-legend">
            <i />
            Родители и дети
            <span className="marriage-line" />
            Супруги
          </span>
          <span>
            {firstYear} — {lastYear}
            <span className="footer-divider">/</span>
            {people.length}{" "}
            {plural(people.length, "история", "истории", "историй")}
          </span>
        </footer>
      </main>
      <footer className="site-footer">
        <span>У каждого имени — своя история.</span>
        <button onClick={() => setAbout(true)}>
          Сохраняем то, что связывает.
          <Sprout size={12} />
        </button>
      </footer>
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
