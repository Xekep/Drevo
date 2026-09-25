import { useEffect, useMemo, useRef } from "react";
import { fullName, years, type Person } from "../../domain";
import {
  horizontalTimeline,
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

function EventText({ item }: { item: TimelineItem }) {
  return (
    <>
      <strong>{item.title}</strong>
      <small>
        {item.date}
        {item.age ? ` · ${item.age}` : ""}
      </small>
      {item.place && <span>{item.place}</span>}
    </>
  );
}

function EventGroup({
  group,
  onChoose,
}: {
  group: TimelineGroup;
  onChoose: () => void;
}) {
  const style = { left: group.x, top: 70 + group.lane * 68 };
  if (group.items.length === 1)
    return (
      <button
        type="button"
        className={`timeline-event is-${group.items[0].kind}`}
        style={style}
        onClick={onChoose}
        title="Открыть карточку человека"
      >
        <EventText item={group.items[0]} />
      </button>
    );
  return (
    <details className="timeline-event timeline-event-group" style={style}>
      <summary>
        <strong>
          {group.year} · событий: {group.items.length}
        </strong>
        <small>{group.items.map((item) => item.title).join(", ")}</small>
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
  const model = useMemo(() => horizontalTimeline(people), [people]);
  const contentWidth = model.width + model.undatedWidth + 190;
  const focusId = focus?.ids[0];

  useEffect(() => {
    const scroll = viewport.current;
    const firstYear = model.rows.reduce<number | null>(
      (first, row) =>
        row.birthYear === null
          ? first
          : first === null
            ? row.birthYear
            : Math.min(first, row.birthYear),
      null,
    );
    if (!scroll || firstYear === null || initialScrollDone.current) return;
    initialScrollDone.current = true;
    const rail =
      parseFloat(
        getComputedStyle(scroll).getPropertyValue("--timeline-person-width"),
      ) || 226;
    scroll.scrollLeft = Math.max(
      0,
      model.yearX(firstYear) - (scroll.clientWidth - rail) / 2,
    );
  }, [model]);

  useEffect(() => {
    const scroll = viewport.current;
    const label = yearLabel.current;
    if (!scroll || !label) return;
    const update = () => {
      const rail =
        parseFloat(
          getComputedStyle(scroll).getPropertyValue("--timeline-person-width"),
        ) || 226;
      const x = scroll.scrollLeft + (scroll.clientWidth - rail) / 2;
      label.textContent = String(model.yearAtX(x));
    };
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [model]);

  useEffect(() => {
    const id = focusId;
    if (!id) return;
    const scroll = viewport.current;
    const row = Array.from(
      board.current?.querySelectorAll<HTMLElement>(".timeline-person-row") ||
        [],
    ).find((element) => element.dataset.personId === id);
    const person = people.find((item) => item.id === id);
    if (!scroll || !row || !person) return;
    scroll.scrollTo({
      top: Math.max(
        0,
        row.offsetTop - scroll.clientHeight / 2 + row.clientHeight / 2,
      ),
      left: person.birth
        ? Math.max(
            0,
            model.yearX(Number(person.birth.slice(0, 4))) -
              (scroll.clientWidth -
                (parseFloat(
                  getComputedStyle(scroll).getPropertyValue(
                    "--timeline-person-width",
                  ),
                ) || 226)) /
                2,
          )
        : scroll.scrollLeft,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [focus?.token, focusId, model, people]);

  /* A scrollable region needs keyboard focus and pointer dragging. */
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <>
      <div className="timeline-center-marker">
        <output ref={yearLabel} aria-label="Год в центре хронологии" aria-live="off">
          {model.start}
        </output>
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
              left: event.key === "ArrowRight" ? 180 : -180,
              behavior: "smooth",
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
            width: `calc(var(--timeline-person-width) + ${contentWidth}px)`,
          }}
        >
          <div className="timeline-background" aria-hidden="true">
            {model.eras.map((era) => (
              <div
                key={era.name}
                className={`timeline-band ${era.className}`}
                style={{
                  left: `calc(var(--timeline-person-width) + ${era.x}px)`,
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
            <span className="timeline-axis-title">Люди и события</span>
            <div
              className="timeline-axis-track"
              style={{ width: contentWidth }}
            >
              {model.ticks.map((tick) => (
                <span key={tick.year} style={{ left: tick.x }}>
                  {tick.year}
                </span>
              ))}
              {model.undatedWidth > 0 && (
                <span
                  className="timeline-undated-label"
                  style={{ left: model.width + 24 }}
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
          {model.rows.map((row) => {
            const lifeEnd = row.deathYear ?? model.currentYear;
            const showLife =
              row.birthYear !== null &&
              lifeEnd >= row.birthYear &&
              (row.deathYear !== null || lifeEnd - row.birthYear <= 110);
            const lifeLeft = showLife
              ? Math.min(model.yearX(row.birthYear!), model.yearX(lifeEnd))
              : 0;
            const lifeWidth = showLife
              ? Math.abs(model.yearX(lifeEnd) - model.yearX(row.birthYear!))
              : 0;
            return (
              <div
                key={row.person.id}
                className={`timeline-person-row${selected.includes(row.person.id) ? " is-selected" : ""}`}
                data-person-id={row.person.id}
                style={{ height: row.height }}
              >
                <button
                  type="button"
                  className="timeline-person"
                  onClick={() => onChoose(row.person.id, false)}
                  aria-label={`Открыть карточку: ${fullName(row.person)}`}
                >
                  <Avatar person={row.person} />
                  <span>
                    <strong>{fullName(row.person)}</strong>
                    <small>{years(row.person) || "Даты неизвестны"}</small>
                    <em>{row.status}</em>
                  </span>
                </button>
                <div
                  className="timeline-row-track"
                  style={{ width: contentWidth }}
                >
                  {showLife && (
                    <div
                      className={`timeline-life${row.deathYear === null ? " is-open" : ""}`}
                      style={{ left: lifeLeft, width: Math.max(4, lifeWidth) }}
                      title={`${row.person.birth} — ${row.person.death || "дата смерти не указана"}`}
                    />
                  )}
                  {row.groups.map((group) => (
                    <EventGroup
                      key={`${row.person.id}:${group.year}`}
                      group={group}
                      onChoose={() => onChoose(row.person.id, false)}
                    />
                  ))}
                  {!!row.undated.length && (
                    <details
                      className="timeline-event timeline-undated-events"
                      style={{ left: model.width + 24, top: 70 }}
                    >
                      <summary>
                        <strong>Без даты · {row.undated.length}</strong>
                        <small>
                          {row.undated.map((item) => item.title).join(", ")}
                        </small>
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
            <div className="timeline-era-track" style={{ width: contentWidth }}>
              {model.eras.map((era) => (
                <button
                  type="button"
                  key={era.name}
                  className={`timeline-era-segment ${era.className}`}
                  style={{ left: era.x, width: era.width }}
                  onClick={() =>
                    viewport.current?.scrollTo({
                      left: Math.max(0, era.x - 50),
                      behavior: "smooth",
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
