import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Sprout, Minus } from "lucide-react";
import { dateLabel, fullName, type Person } from "../../domain";
import { counted } from "../../domain/archive-summary";
import {
  horizontalTimeline,
  timelineRowsAtYear,
  type TimelineGroup,
  type TimelineItem,
} from "../../domain/horizontal-timeline";
import { Avatar } from "../person-panel";
import "../../styles/timeline.css";

const emblems: Record<string, string> = {
  "Российская империя": "/eras/russian-empire.svg",
  "Советский Союз": "/eras/soviet-union.svg",
  Россия: "/eras/russian-federation.svg",
};

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth";
}

function EventText({ item }: { item: TimelineItem }) {
  return (
    <>
      <strong>{item.title}</strong>
      <small>
        {dateLabel(item.date)}
        {item.age ? ` · ${item.age}` : ""}
      </small>
      {item.place && <span>{item.place}</span>}
    </>
  );
}

function EventGroup({
  group,
  current,
  onChoose,
}: {
  group: TimelineGroup;
  current: boolean;
  onChoose: () => void;
}) {
  const kind = group.items.length === 1 ? group.items[0].kind : "group";
  return (
    <details
      className={`timeline-event is-${kind}${current ? " is-current" : ""}`}
      style={{ left: `calc(var(--timeline-pad) + ${group.x}px)` }}
    >
      <summary
        aria-label={`${group.year}: ${group.items.map((item) => item.title).join(", ")}`}
        title={`${group.year}: ${group.items.map((item) => item.title).join(", ")}`}
      >
        {group.items.length > 1 ? (
          group.items.length
        ) : kind === "birth" ? (
          <Sprout size={15} aria-hidden="true" />
        ) : kind === "death" ? (
          <Minus size={15} aria-hidden="true" />
        ) : (
          "•"
        )}
      </summary>
      <div className="timeline-event-list">
        {group.items.map((item) => (
          <button type="button" key={item.id} onClick={onChoose}>
            <EventText item={item} />
          </button>
        ))}
      </div>
    </details>
  );
}

export function HorizontalTimeline({
  people,
  selected,
  focus,
  onChoose,
}: {
  people: Person[];
  selected: string[];
  focus: { ids: string[]; token: number } | null;
  onChoose: (id: string, additive?: boolean) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const yearLabel = useRef<HTMLOutputElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    active: boolean;
  } | null>(null);
  const initialScrollDone = useRef(false);
  const lastHorizontalFocusToken = useRef<number | null>(null);
  const lastFocusedToken = useRef<number | null>(null);
  const model = useMemo(() => horizontalTimeline(people), [people]);
  const firstYear = model.rows[0]?.birthYear ?? model.start;
  const [year, setYear] = useState(firstYear);
  const visibleRows = useMemo(
    () => timelineRowsAtYear(model.rows, year),
    [model, year],
  );
  const [renderedRows, setRenderedRows] = useState(() =>
    visibleRows.map((row) => ({ row, exiting: false })),
  );
  const contentWidth = model.width + model.undatedWidth + 190;
  const focusId = focus?.ids[0];

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (!scroll) return;
    const measure = () => {
      const rail =
        parseFloat(
          getComputedStyle(scroll).getPropertyValue("--timeline-person-width"),
        ) || 226;
      scroll.style.setProperty(
        "--timeline-pad",
        `${Math.max(0, (scroll.clientWidth - rail) / 2)}px`,
      );
      scroll.style.setProperty(
        "--timeline-viewport-height",
        `${scroll.clientHeight}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const ids = new Set(visibleRows.map((row) => row.person.id));
    const update = window.setTimeout(() => {
      setRenderedRows((previous) => {
        const previousIds = new Set(previous.map(({ row }) => row.person.id));
        return model.rows
          .filter(
            (row) => ids.has(row.person.id) || previousIds.has(row.person.id),
          )
          .map((row) => ({ row, exiting: !ids.has(row.person.id) }));
      });
    }, 0);
    const remove = window.setTimeout(() => {
      setRenderedRows((current) => current.filter(({ exiting }) => !exiting));
    }, 260);
    return () => {
      window.clearTimeout(update);
      window.clearTimeout(remove);
    };
  }, [model, visibleRows]);

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (!scroll || !model.rows.length || initialScrollDone.current) return;
    initialScrollDone.current = true;
    scroll.scrollLeft = model.yearX(firstYear);
    setYear(firstYear);
  }, [firstYear, model]);

  useEffect(() => {
    const scroll = viewport.current;
    const label = yearLabel.current;
    if (!scroll || !label) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = model.yearAtX(scroll.scrollLeft);
        label.textContent = String(next);
        scroll.style.setProperty(
          "--timeline-scroll-top",
          `${scroll.scrollTop}px`,
        );
        setYear((current) => (current === next ? current : next));
      });
    };
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", update);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [model]);

  useEffect(() => {
    const id = focusId;
    if (!id || focus?.token === lastHorizontalFocusToken.current) return;
    const scroll = viewport.current;
    const person = people.find((item) => item.id === id);
    if (!scroll || !person?.birth) return;
    lastHorizontalFocusToken.current = focus?.token ?? null;
    scroll.scrollTo({
      left: model.yearX(Number(person.birth.slice(0, 4))),
      behavior: scrollBehavior(),
    });
  }, [focus?.token, focusId, model, people]);

  useEffect(() => {
    if (!focusId || focus?.token === lastFocusedToken.current) return;
    const scroll = viewport.current;
    const row = Array.from(
      board.current?.querySelectorAll<HTMLElement>(".timeline-person-row") ||
        [],
    ).find((element) => element.dataset.personId === focusId);
    if (!scroll || !row) return;
    lastFocusedToken.current = focus?.token ?? null;
    scroll.scrollTo({
      top: Math.max(
        0,
        row.offsetTop - scroll.clientHeight / 2 + row.clientHeight / 2,
      ),
      behavior: scrollBehavior(),
    });
  }, [focus?.token, focusId, renderedRows]);

  const currentEventCount = visibleRows.reduce(
    (total, row) =>
      total +
      (row.groups.find((group) => group.year === year)?.items.length || 0),
    0,
  );
  const stepYear = (delta: number) => {
    viewport.current?.scrollTo({
      left: model.yearX(
        Math.min(model.end, Math.max(model.start, year + delta)),
      ),
      behavior: scrollBehavior(),
    });
  };

  /* A scrollable region needs keyboard focus and pointer dragging. */
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <>
      <div className="timeline-center-marker">
        <div className="timeline-year-controls">
          <button
            type="button"
            onClick={() => stepYear(-10)}
            disabled={year <= model.start}
            aria-label="На 10 лет назад"
            title="На 10 лет назад"
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => stepYear(10)}
            disabled={year >= model.end}
            aria-label="На 10 лет вперёд"
            title="На 10 лет вперёд"
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
        <output
          ref={yearLabel}
          aria-label="Год в центре хронологии"
          aria-live="off"
        >
          {year}
        </output>
        <span>
          {counted(visibleRows.length, ["человек", "человека", "человек"])} ·{" "}
          {counted(currentEventCount, ["событие", "события", "событий"])}
        </span>
      </div>
      <div
        ref={viewport}
        className="horizontal-timeline"
        role="region"
        aria-label="Горизонтальная хронология людей и событий"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            event.currentTarget.scrollBy({
              left:
                (event.key === "ArrowRight" ? 1 : -1) *
                (event.shiftKey ? 120 : 12),
              behavior: scrollBehavior(),
            });
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            event.currentTarget.scrollTo({
              left: event.key === "Home" ? 0 : model.width,
              behavior: scrollBehavior(),
            });
          }
        }}
        onPointerDown={(event) => {
          if (
            event.pointerType !== "mouse" ||
            event.button !== 0 ||
            (event.target as Element).closest("button, summary, a, input")
          )
            return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
            active: false,
          };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (!current.active && Math.hypot(dx, dy) < 5) return;
          if (!current.active) {
            current.active = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.classList.add("is-dragging");
          }
          event.currentTarget.scrollLeft = current.left - dx;
          event.currentTarget.scrollTop = current.top - dy;
        }}
        onPointerUp={(event) => {
          drag.current = null;
          event.currentTarget.classList.remove("is-dragging");
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          drag.current = null;
          event.currentTarget.classList.remove("is-dragging");
        }}
      >
        <div
          ref={board}
          className="timeline-board"
          style={{
            width: `calc(var(--timeline-person-width) + ${contentWidth}px + var(--timeline-pad) + var(--timeline-pad))`,
          }}
        >
          <div className="timeline-background" aria-hidden="true">
            {model.eras.map((era) => (
              <div
                key={era.name}
                className={`timeline-band ${era.className}`}
                style={{
                  left: `calc(var(--timeline-person-width) + var(--timeline-pad) + ${era.x}px)`,
                  width: era.width,
                }}
              >
                {emblems[era.name] && era.width > 180 && (
                  <img
                    src={emblems[era.name]}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="timeline-axis">
            <span className="timeline-axis-title">
              <strong>Люди и события</strong>
              <small>в выбранном году</small>
            </span>
            <div
              className="timeline-axis-track"
              style={{
                width: `calc(${contentWidth}px + var(--timeline-pad) + var(--timeline-pad))`,
              }}
            >
              {model.ticks.map((tick) => (
                <span
                  key={tick.year}
                  style={{ left: `calc(var(--timeline-pad) + ${tick.x}px)` }}
                >
                  {tick.year}
                </span>
              ))}
              {model.undatedWidth > 0 && (
                <span
                  className="timeline-undated-label"
                  style={{
                    left: `calc(var(--timeline-pad) + ${model.width + 24}px)`,
                  }}
                >
                  Без даты
                </span>
              )}
            </div>
          </div>
          {!model.rows.length && (
            <p className="timeline-empty">
              В хронологии пока нет людей с датой рождения.
            </p>
          )}
          {!!model.rows.length &&
            !visibleRows.length &&
            !renderedRows.length && (
              <p className="timeline-empty">
                В {year} году здесь пока нет людей с известной датой рождения.
              </p>
            )}
          {renderedRows.map(({ row, exiting }) => {
            const birthYear = row.birthYear ?? year;
            const lifeEnd = Math.min(year, row.deathYear ?? year);
            const age = year - birthYear;
            const status =
              row.deathYear === year
                ? "Год смерти"
                : age > 110 && row.deathYear === null
                  ? "Нет даты смерти"
                  : year === birthYear
                    ? "Год рождения"
                    : `≈ ${age} лет`;
            return (
              <div
                key={row.person.id}
                className={`timeline-person-row${selected.includes(row.person.id) ? " is-selected" : ""}${exiting ? " is-exiting" : ""}${row.deathYear === null && age > 110 ? " is-uncertain" : ""}`}
                data-person-id={row.person.id}
              >
                <button
                  type="button"
                  className="timeline-person"
                  onClick={() => onChoose(row.person.id, false)}
                  aria-label={`Открыть карточку: ${fullName(row.person)}`}
                >
                  <Avatar person={row.person} />
                  <span>
                    <strong>{row.person.surname || row.person.name}</strong>
                    <span>
                      {row.person.surname
                        ? [row.person.name, row.person.patronymic]
                            .filter(Boolean)
                            .join(" ")
                        : row.person.patronymic}
                    </span>
                    <small>{status}</small>
                  </span>
                </button>
                <div
                  className="timeline-row-track"
                  style={{
                    width: `calc(${contentWidth}px + var(--timeline-pad) + var(--timeline-pad))`,
                  }}
                >
                  <div
                    className={`timeline-life${row.deathYear === null ? " is-open" : ""}`}
                    style={{
                      left: `calc(var(--timeline-pad) + ${model.yearX(birthYear)}px)`,
                      width: Math.max(
                        4,
                        model.yearX(lifeEnd) - model.yearX(birthYear),
                      ),
                    }}
                    title={`${row.person.birth} — ${row.person.death || "дата смерти не указана"}`}
                  />
                  {row.groups
                    .filter((group) => group.year <= year)
                    .map((group) => (
                      <EventGroup
                        key={`${row.person.id}:${group.year}`}
                        group={group}
                        current={group.year === year}
                        onChoose={() => onChoose(row.person.id, false)}
                      />
                    ))}
                  {!!row.undated.length && (
                    <details
                      className="timeline-event timeline-undated-events"
                      style={{
                        left: `calc(var(--timeline-pad) + ${model.width + 24}px)`,
                      }}
                    >
                      <summary
                        aria-label={`Без даты: ${row.undated.length} событий`}
                        title="События без даты"
                      >
                        ?
                      </summary>
                      <div className="timeline-event-list">
                        {row.undated.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            onClick={() => onChoose(row.person.id, false)}
                          >
                            <EventText item={item} />
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
          <div className="timeline-era-bar" aria-label="Исторические эпохи">
            <span className="timeline-era-heading">Эпохи</span>
            <div
              className="timeline-era-track"
              style={{
                width: `calc(${contentWidth}px + var(--timeline-pad) + var(--timeline-pad))`,
              }}
            >
              {model.eras.map((era) => (
                <button
                  type="button"
                  key={era.name}
                  className={`timeline-era-segment ${era.className}`}
                  style={{
                    left: `calc(var(--timeline-pad) + ${era.x}px)`,
                    width: era.width,
                  }}
                  onClick={() =>
                    viewport.current?.scrollTo({
                      left: era.x + era.width / 2,
                      behavior: scrollBehavior(),
                    })
                  }
                  title={`${era.name} · ${era.start}–${era.end}`}
                >
                  <strong>{era.short}</strong>
                  {era.width > 150 && (
                    <small>
                      {Math.max(model.start, era.start)}–
                      {Math.min(model.end, era.end)}
                    </small>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
