"use client";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable graph region needs keyboard focus for arrow-key navigation. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
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
  ageLabel,
  analyzeKinship,
  dateLabel,
  dateYear,
  edgeLabel,
  END_YEAR,
  ERAS,
  fullName,
  initials,
  NODE_HEIGHT,
  NODE_WIDTH,
  plural,
  position,
  RAIL_WIDTH,
  safeUrl,
  START_YEAR,
  validateFamily,
  YEAR_HEIGHT,
  yearY,
  years,
  type Family,
  type Person,
  type Relation,
} from "../lib/genealogy";

const roman = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const normalize = (text: string) =>
  text.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
const WORLD_HEIGHT = yearY(END_YEAR) + 140;

function Avatar({
  person,
  large = false,
}: {
  person: Person;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = safeUrl(person.photo);
  return (
    <span
      className={`${large ? "profile-avatar" : "person-avatar"} ${person.sex === "f" ? "female" : "male"}`}
    >
      {/* Native image keeps optional archive photos independent of an image service. */}
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- Archive photos support standalone static hosting.
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        initials(person)
      )}
    </span>
  );
}

function Connections({
  people,
  highlighted,
  width,
}: {
  people: Person[];
  highlighted: string[];
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = WORLD_HEIGHT * ratio;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, WORLD_HEIGHT);
    const map = new Map(people.map((p) => [p.id, p]));
    function line(from: Person, to: Person, marriage: boolean) {
      const p = position(from),
        q = position(to);
      const match = highlighted.some(
        (id, i) =>
          i > 0 &&
          ((id === to.id && highlighted[i - 1] === from.id) ||
            (id === from.id && highlighted[i - 1] === to.id)),
      );
      ctx!.strokeStyle = match
        ? "#527561"
        : highlighted.length
          ? "#e1e6dd"
          : marriage
            ? "#b8bba8"
            : "#c6cfbd";
      ctx!.lineWidth = match ? 2.3 : 1.2;
      ctx!.setLineDash(marriage ? [3, 4] : []);
      ctx!.beginPath();
      if (marriage) {
        const left = p.x < q.x ? p : q,
          right = p.x < q.x ? q : p;
        const x = (left.x + NODE_WIDTH + right.x) / 2;
        ctx!.moveTo(left.x + NODE_WIDTH, left.y + 43);
        ctx!.lineTo(x, left.y + 43);
        ctx!.lineTo(x, right.y + 43);
        ctx!.lineTo(right.x, right.y + 43);
      } else {
        const sx = p.x + NODE_WIDTH / 2,
          sy = p.y + NODE_HEIGHT;
        const ex = q.x + NODE_WIDTH / 2,
          ey = q.y;
        const mid = sy + Math.max(18, (ey - sy) * 0.52);
        ctx!.moveTo(sx, sy);
        ctx!.lineTo(sx, mid);
        ctx!.lineTo(ex, mid);
        ctx!.lineTo(ex, ey);
      }
      ctx!.stroke();
      if (!marriage) {
        ctx!.setLineDash([]);
        ctx!.fillStyle = ctx!.strokeStyle;
        ctx!.beginPath();
        ctx!.arc(q.x + NODE_WIDTH / 2, q.y - 3, 2.3, 0, Math.PI * 2);
        ctx!.fill();
      }
    }
    const drawn = new Set<string>();
    for (const p of people) {
      for (const parent of p.parents)
        if (map.has(parent)) line(map.get(parent)!, p, false);
      for (const spouse of p.spouses) {
        const key = [p.id, spouse].sort().join(":");
        if (!drawn.has(key) && map.has(spouse)) {
          line(p, map.get(spouse)!, true);
          drawn.add(key);
        }
      }
    }
  }, [people, highlighted, width]);
  return (
    <canvas
      ref={ref}
      className="connections"
      style={{ width, height: WORLD_HEIGHT }}
      aria-hidden="true"
    />
  );
}

function LifeSpan({ person }: { person: Person }) {
  const birth = dateYear(person.birth),
    death = dateYear(person.death);
  const lived = ERAS.filter((e) => e.start <= death && e.end > birth);
  return (
    <div className="lifespan">
      <div className="section-label">ВРЕМЯ ЖИЗНИ</div>
      <div
        className="lifespan-bar"
        aria-label={`Жизнь с ${birth} по ${person.death ? death : "настоящее время"}`}
      >
        {lived.map((e) => (
          <span
            key={e.name}
            title={`${e.name}: ${Math.max(e.start, birth)}–${Math.min(e.end, death)}`}
            style={{
              background: e.color,
              flex: Math.max(
                1,
                Math.min(e.end, death) - Math.max(e.start, birth),
              ),
            }}
          />
        ))}
      </div>
      <div className="lifespan-dates">
        <span>{birth}</span>
        <span>{person.death ? death : "сегодня"}</span>
      </div>
      <div className="lifespan-legend">
        {lived.map((e) => (
          <span key={e.name}>
            <i style={{ background: e.color }} />
            {e.short}
          </span>
        ))}
      </div>
    </div>
  );
}

function PersonPanel({
  person,
  people,
  onSelect,
  onCompare,
}: {
  person: Person;
  people: Person[];
  onSelect: (id: string) => void;
  onCompare: () => void;
}) {
  const [tab, setTab] = useState<"bio" | "sources">("bio");
  const relatives = people.filter(
    (p) =>
      person.parents.includes(p.id) ||
      person.spouses.includes(p.id) ||
      p.spouses.includes(person.id) ||
      p.parents.includes(person.id) ||
      (p.id !== person.id &&
        p.parents.some((id) => person.parents.includes(id))),
  );
  return (
    <>
      <div className="profile-head">
        <Avatar person={person} large />
        <span className="profile-generation">
          {roman[person.generation] || person.generation} поколение
        </span>
        <h2>
          {person.surname}
          <br />
          <span>
            {person.name} {person.patronymic}
          </span>
        </h2>
        {person.maidenName && (
          <div className="maiden-name">в девичестве {person.maidenName}</div>
        )}
        <p>
          {years(person)}
          <span>·</span>
          {ageLabel(person)}
        </p>
      </div>
      <div
        className="panel-tabs"
        role="tablist"
        aria-label="Сведения о человеке"
      >
        <button
          role="tab"
          id="bio-tab"
          aria-controls="person-tab-content"
          aria-selected={tab === "bio"}
          className={tab === "bio" ? "active" : ""}
          onClick={() => setTab("bio")}
        >
          О человеке
        </button>
        <button
          role="tab"
          id="sources-tab"
          aria-controls="person-tab-content"
          aria-selected={tab === "sources"}
          className={tab === "sources" ? "active" : ""}
          onClick={() => setTab("sources")}
        >
          Источники <span className="count-badge">{person.sources.length}</span>
        </button>
      </div>
      <div
        className="profile-content"
        id="person-tab-content"
        role="tabpanel"
        aria-labelledby={tab === "bio" ? "bio-tab" : "sources-tab"}
      >
        {tab === "bio" ? (
          <>
            <div className="life-event">
              <span className="event-icon">
                <Sprout size={13} />
              </span>
              <div>
                <span className="event-label">Рождение</span>
                <b>{dateLabel(person.birth)}</b>
                <p>{person.birthPlace}</p>
              </div>
            </div>
            {person.death ? (
              <div className="life-event">
                <span className="event-icon">†</span>
                <div>
                  <span className="event-label">Уход из жизни</span>
                  <b>{dateLabel(person.death)}</b>
                  <p>{person.deathPlace || "Место не указано"}</p>
                </div>
              </div>
            ) : (
              <div className="living-note">
                <span className="tiny-dot" />
                История продолжается
              </div>
            )}
            <LifeSpan person={person} />
            {(person.biography || person.occupation) && (
              <div className="biography">
                <h3>{person.occupation || "Сохранённая история"}</h3>
                {person.biography && <p>{person.biography}</p>}
              </div>
            )}
            <div className="relatives">
              <h3>
                Семейные связи <span>{relatives.length}</span>
              </h3>
              {relatives.length ? (
                relatives.map((p) => (
                  <button key={p.id} onClick={() => onSelect(p.id)}>
                    <Avatar person={p} />
                    <span>
                      <b>
                        {p.name} {p.surname}
                      </b>
                      <small>
                        {analyzeKinship(person, p, people).roles?.[1].term ||
                          edgeLabel(person, p)}
                      </small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                ))
              ) : (
                <p className="muted-copy">
                  Родственные связи пока не добавлены.
                </p>
              )}
            </div>
            <button className="full-button" onClick={onCompare}>
              <ArrowDownUp size={14} />
              Узнать родство с другим человеком
            </button>
          </>
        ) : (
          <>
            <div className="section-label">ДОКУМЕНТЫ И СВИДЕТЕЛЬСТВА</div>
            {person.sources.length ? (
              person.sources.map((s, i) => (
                <div className="source-card" key={`${s.title}-${i}`}>
                  <div className="source-type">
                    <FileText size={13} />
                    {s.type}
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.reference}</p>
                  {s.note && <small>{s.note}</small>}
                  {safeUrl(s.url) ? (
                    <a
                      href={safeUrl(s.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Открыть источник
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    <span className="source-unavailable">
                      Ссылка пока не добавлена
                    </span>
                  )}
                </div>
              ))
            ) : (
              <div className="empty-sources">
                <BookOpen size={28} strokeWidth={1} />
                <h3>У истории ещё есть пробелы</h3>
                <p>Источники об этом человеке пока не добавлены в архив.</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ComparisonPanel({
  selected,
  relation,
  people,
  onRemove,
  onReveal,
}: {
  selected: Person[];
  relation: Relation | null;
  people: Person[];
  onRemove: (id: string) => void;
  onReveal: () => void;
}) {
  const map = new Map(people.map((p) => [p.id, p]));
  return (
    <div className="comparison-content">
      <span className="comparison-symbol">
        <ArrowDownUp size={23} strokeWidth={1.3} />
      </span>
      <h2>Как мы связаны</h2>
      <p className="compare-intro">
        Две истории. Найдём то,
        <br />
        что их объединяет.
      </p>
      <div className="comparison-people">
        {[0, 1].map((i) =>
          selected[i] ? (
            <div className="selected-person" key={selected[i].id}>
              <Avatar person={selected[i]} />
              <div>
                <b>
                  {selected[i].name} {selected[i].surname}
                </b>
                <span>{years(selected[i])}</span>
              </div>
              <button
                aria-label={`Убрать ${fullName(selected[i])} из сравнения`}
                onClick={() => onRemove(selected[i].id)}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <div className="empty-person" key={i}>
              <span>{i + 1}</span>
              <p>
                Выберите {i === 0 ? "первого" : "второго"}
                <br />
                человека на древе
              </p>
              <Plus size={15} />
            </div>
          ),
        )}
      </div>
      {relation ? (
        <>
          <div className={`relation-result ${relation.kind}`} role="status">
            <span className="section-label">
              {relation.kind === "unknown"
                ? "НУЖНО БОЛЬШЕ ДАННЫХ"
                : "СВЯЗЬ НАЙДЕНА"}
            </span>
            <h3>{relation.title}</h3>
            {relation.roles && (
              <div className="relation-directions">
                {relation.roles.map((role, i) => (
                  <div className="relation-direction" key={selected[i].id}>
                    <div>
                      <span>{selected[i].name}</span>
                      <ArrowRight size={10} />
                      <span>{selected[1 - i].name}</span>
                    </div>
                    <strong>{role.term}</strong>
                    <p>{role.description}</p>
                    {role.aliases?.length ? (
                      <small>Также: {role.aliases.join(", ")}</small>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            <p>{relation.explanation}</p>
          </div>
          {relation.path.length > 0 && (
            <>
              <div className="path-heading">
                <span className="section-label">ЦЕПОЧКА РОДСТВА</span>
                <span>
                  {relation.path.length - 1}{" "}
                  {plural(relation.path.length - 1, "связь", "связи", "связей")}
                </span>
              </div>
              <ol className="kinship-path">
                {relation.path.map((id, i) => {
                  const p = map.get(id)!;
                  return (
                    <li
                      key={id}
                      className={
                        relation.common.includes(id) ? "common-ancestor" : ""
                      }
                    >
                      {i > 0 && (
                        <div className="path-edge">
                          <ArrowDown size={10} />
                          {edgeLabel(map.get(relation.path[i - 1])!, p)}
                        </div>
                      )}
                      <div className="path-person">
                        <span className="path-dot" />
                        <span>
                          <b>
                            {p.name} {p.surname}
                          </b>
                          <small>
                            {years(p)}
                            {relation.common.includes(id) && " · общий предок"}
                          </small>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <button className="full-button" onClick={onReveal}>
                <Maximize2 size={13} />
                Показать цепочку на древе
              </button>
            </>
          )}
          <p className="comparison-footnote">
            Анализ по связям, указанным в семейном архиве.
          </p>
        </>
      ) : (
        <div className="comparison-hint">
          <TreeDeciduous size={25} strokeWidth={1} />
          <p>
            Нажмите на карточку в древе.
            <br />
            Можно также выбрать двух людей
            <br />с зажатой клавишей Shift.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Drevo() {
  const [family, setFamily] = useState<Family | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [view, setView] = useState<"tree" | "list">("tree");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [zoom, setZoom] = useState(0.9);
  const [currentYear, setCurrentYear] = useState(START_YEAR);
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
          )
        : null,
    [selected, personMap, people],
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let active = true;
    fetch("/data/family.json", { signal: controller.signal, cache: "no-cache" })
      .then((response) => {
        if (!response.ok)
          throw new Error("Не удалось загрузить семейный архив");
        return response.json();
      })
      .then((value) => {
        const data = validateFamily(value);
        if (active) {
          setFamily(data);
          setError("");
          if (window.innerWidth > 760)
            setSelected([
              data.people.some((p) => p.id === "alexander-old")
                ? "alexander-old"
                : data.people[0].id,
            ]);
        }
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error && reason.name !== "AbortError"
              ? reason.message
              : "Архив загружается слишком долго. Попробуйте ещё раз.",
          );
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [attempt]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const typing =
        event.target instanceof HTMLElement &&
        !!event.target.closest("input,textarea,[contenteditable]");
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
    [personMap, zoom],
  );
  function choose(id: string, additive = false, move = false) {
    if (drag.current?.moved) return;
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
          <button onClick={() => setAbout(true)}>
            Об архиве
            <ArrowUpRight size={11} />
          </button>
        </nav>
        <div className="header-right">
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
                    setError("");
                    setAttempt(attempt + 1);
                  }}
                >
                  Попробовать снова
                </button>
              )}
            </div>
          ) : (
            <>
              {view === "tree" ? (
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
                        {ERAS.map((e) => {
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
                        {[
                          { name: "XIX", year: START_YEAR },
                          { name: "XX", year: 1900 },
                          { name: "XXI", year: 2000 },
                        ].map((c) => (
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
                          {ERAS.filter((e) => e.start > START_YEAR).map((e) => (
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
                              { length: 21 },
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
                      <PersonPanel
                        key={chosen[0].id}
                        person={chosen[0]}
                        people={people}
                        onSelect={chooseRelative}
                        onCompare={() => setCompare(true)}
                      />
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
