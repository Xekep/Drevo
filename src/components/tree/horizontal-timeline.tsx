import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight, Sprout, Minus } from "lucide-react";
import { dateLabel, fullName, hasRecordedDeath, type Person } from "../../domain";
import { counted } from "../../domain/archive-summary";
import {
  horizontalTimeline,
  timelineRowsAtYear,
  type TimelineGroup,
  type TimelineItem,
  type TimelineRow,
} from "../../domain/horizontal-timeline";
import { Avatar } from "../person-panel";
import { timelineRowWindow } from "../../domain/timeline-window";
import "../../styles/timeline.css";

const VIRTUAL_ROW_THRESHOLD = 32;

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

function revealLifelines(bars: readonly HTMLElement[], scrollLeft: number) {
  for (const bar of bars) {
    const start = Number(bar.dataset.startX);
    const width = Number(bar.dataset.lifeWidth);
    const visible = Math.min(width, Math.max(0, scrollLeft - start + 4));
    bar.style.transform = `scaleX(${visible / width})`;
  }
}

function EventText({ item }: { item: TimelineItem }) {
  return (
    <>
      <strong>{item.title}</strong>
      <small>
        {item.estimated ? "≈ " : ""}
        {dateLabel(item.date)}
        {item.age ? ` · ${item.age}` : ""}
      </small>
      {item.place && <span>{item.place}</span>}
      {item.description && <span>{item.description}</span>}
    </>
  );
}

function EventGroup({
  group,
  current,
  onChoose,
  open,
  onOpenChange,
}: {
  group: TimelineGroup;
  current: boolean;
  onChoose: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const kind = group.items.length === 1 ? group.items[0].kind : "group";
  const estimated = group.items.some((item) => item.estimated);
  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className={`timeline-event is-${kind}${estimated ? " is-estimated" : ""}${current ? " is-current" : ""}`}
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
          estimated ? "≈" : <Minus size={15} aria-hidden="true" />
        ) : (
          "•"
        )}
      </summary>
      {open && (
        <div className="timeline-event-list">
          {group.items.map((item) => (
            <button type="button" key={item.id} onClick={onChoose}>
              <EventText item={item} />
            </button>
          ))}
        </div>
      )}
    </details>
  );
}

const TimelinePersonRow = memo(function TimelinePersonRow({
  row,
  exiting,
  selected,
  year,
  model,
  count,
  position,
  openEvents,
  onChoose,
  changeOpenEvent,
}: {
  row: TimelineRow;
  exiting: boolean;
  selected: boolean;
  year: number;
  model: ReturnType<typeof horizontalTimeline>;
  count: number;
  position: number;
  openEvents: ReadonlySet<string>;
  onChoose: (id: string, additive?: boolean) => void;
  changeOpenEvent: (key: string, open: boolean) => void;
}) {
  const contentWidth = model.width;
  const birthYear = row.birthYear ?? year;
  const endYear = row.deathYear ?? row.estimatedDeath?.year ?? null;
  const unknownDeath = hasRecordedDeath(row.person) && endYear === null;
  const lifeWidth = Math.max(
    4,
    model.yearX(endYear ?? (unknownDeath ? model.currentYear : model.end)) - model.yearX(birthYear),
  );
  const age = year - birthYear;
  const status =
    endYear === year
      ? row.estimatedDeath ? "≈ Смерть" : "Год смерти"
      : unknownDeath || (age > 110 && endYear === null)
        ? "Дата смерти неизвестна"
        : year === birthYear
          ? "Год рождения"
          : `≈ ${age} лет`;
  return (
    <div
      className={`timeline-person-row${selected ? " is-selected" : ""}${exiting ? " is-exiting" : ""}${unknownDeath || (endYear === null && age > 110) ? " is-uncertain" : ""}`}
      data-person-id={row.person.id}
      role="listitem"
      aria-setsize={count}
      aria-posinset={position}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
    >
      <button
        type="button"
        className="timeline-person"
        onClick={() => onChoose(row.person.id, false)}
        aria-label={`Открыть карточку: ${fullName(row.person)}`}
      >
        <Avatar person={row.person} preview="avatar" />
        <span>
          <strong>{row.person.surname || row.person.name}</strong>
          <span>
            {row.person.surname
              ? [row.person.name, row.person.patronymic]
                  .filter(Boolean)
                  .join(" ")
              : row.person.patronymic}
          </span>
          <small title={row.estimatedDeath?.year === year ? "Предположительный год смерти" : status}>{status}</small>
        </span>
      </button>
      <div
        className="timeline-row-track"
        style={{
          width: `calc(${contentWidth}px + var(--timeline-pad) + var(--timeline-pad))`,
        }}
      >
        <div
          className={`timeline-life${endYear === null ? " is-open" : ""}${row.estimatedDeath ? " is-estimated" : ""}`}
          data-start-x={model.yearX(birthYear)}
          data-life-width={lifeWidth}
          style={{
            left: `calc(var(--timeline-pad) + ${model.yearX(birthYear)}px)`,
            width: lifeWidth,
          }}
          title={`${row.person.birth} — ${row.person.death || (row.estimatedDeath ? `≈ ${row.estimatedDeath.year} (предположительная смерть)` : "дата смерти не указана")}`}
        />
        {row.groups
          .filter((group) => group.year <= year)
          .map((group) => (
            <EventGroup
              key={`${row.person.id}:${group.year}`}
              group={group}
              current={group.year === year}
              onChoose={() => onChoose(row.person.id, false)}
              open={openEvents.has(`${row.person.id}\u0000${group.year}`)}
              onOpenChange={(open) =>
                changeOpenEvent(`${row.person.id}\u0000${group.year}`, open)
              }
            />
          ))}
      </div>
    </div>
  );
});

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
  const lifelines = useRef<HTMLElement[]>([]);
  const currentScrollLeft = useRef(0);
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
  const pendingHorizontalFocus = useRef<{ token: number; left: number } | null>(
    null,
  );
  const [horizontalFocusReady, setHorizontalFocusReady] = useState<
    number | null
  >(null);
  const model = useMemo(() => horizontalTimeline(people), [people]);
  const firstYear = model.rows[0]?.birthYear ?? model.start;
  const [year, setYear] = useState(firstYear);
  const visibleRows = useMemo(
    () => timelineRowsAtYear(model.rows, year, model.currentYear),
    [model, year],
  );
  const visibleRowIds = useMemo(
    () => visibleRows.map((row) => row.person.id).join("\u0000"),
    [visibleRows],
  );
  const [renderedRows, setRenderedRows] = useState(() =>
    visibleRows.map((row) => ({ row, exiting: false })),
  );
  const rowsRef = useRef(renderedRows);
  const metrics = useRef({ height: 640, rowHeight: 64 });
  const [view, setView] = useState({ top: 0, height: 640, rowHeight: 64 });
  const [focusedPerson, setFocusedPerson] = useState<string | null>(null);
  const focusedPersonRef = useRef<string | null>(null);
  const [openEvents, setOpenEvents] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const verticalFocusStarted = useRef<number | null>(null);
  const keyboardTarget = useRef<{ id: string; edge: "first" | "last" } | null>(
    null,
  );
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);
  const [windowed, setWindowed] = useState(
    model.rows.length > VIRTUAL_ROW_THRESHOLD,
  );
  // Once an archive needs a window, keep its fixed grid even at sparse years.
  // Crossing 32 rows must not replay the entry animation of existing people.
  const virtualized = windowed || model.rows.length > VIRTUAL_ROW_THRESHOLD;
  const rowWindow = timelineRowWindow(
    renderedRows.length,
    view.top,
    view.height,
    view.rowHeight,
  );
  const renderedRowPositions = useMemo(
    () => new Map(renderedRows.map(({ row }, index) => [row.person.id, index])),
    [renderedRows],
  );
  const mountedIndices = useMemo(() => {
    if (!virtualized) return renderedRows.map((_, index) => index);
    const indices = Array.from(
      { length: rowWindow.end - rowWindow.start },
      (_, index) => rowWindow.start + index,
    );
    // Keep the element owning keyboard focus connected while it is off screen.
    const focused =
      focusedPerson === null
        ? -1
        : (renderedRowPositions.get(focusedPerson) ?? -1);
    if (focused >= 0 && (focused < rowWindow.start || focused >= rowWindow.end))
      indices.push(focused);
    return indices.sort((a, b) => a - b);
  }, [
    virtualized,
    renderedRows,
    rowWindow.start,
    rowWindow.end,
    focusedPerson,
    renderedRowPositions,
  ]);
  const rowPositions = useMemo(
    () => new Map(visibleRows.map((row, index) => [row.person.id, index])),
    [visibleRows],
  );
  const syncViewport = useCallback((scrollTop?: number) => {
    const scroll = viewport.current;
    if (!scroll) return;
    const { height, rowHeight } = metrics.current;
    const next = {
      top: Math.floor((scrollTop ?? scroll.scrollTop) / rowHeight) * rowHeight,
      height,
      rowHeight,
    };
    setView((previous) =>
      previous.top === next.top &&
      previous.height === next.height &&
      previous.rowHeight === next.rowHeight
        ? previous
        : next,
    );
  }, []);
  const captureScrollAnchor = useCallback(() => {
    const scroll = viewport.current,
      rows = rowsRef.current;
    if (!scroll || rows.length <= VIRTUAL_ROW_THRESHOLD) return;
    const height = metrics.current.rowHeight;
    const index = Math.min(
      rows.length - 1,
      Math.floor(scroll.scrollTop / height),
    );
    const row = rows[index];
    if (row)
      scrollAnchor.current = {
        id: row.row.person.id,
        offset: scroll.scrollTop - 86 - index * height,
      };
  }, []);
  const changeOpenEvent = useCallback((key: string, open: boolean) => {
    setOpenEvents((previous) => {
      if (previous.has(key) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const contentWidth = model.width;
  const focusId = focus?.ids[0];
  const focusToken = focus?.token;
  const cancelFocus = useCallback(() => {
    pendingHorizontalFocus.current = null;
    lastFocusedToken.current = lastHorizontalFocusToken.current;
  }, []);

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (!scroll) return;
    const measure = () => {
      // Read the viewport before writing custom properties. Reading computed
      // style again after --timeline-pad changes forces a second style pass.
      const style = getComputedStyle(scroll);
      const rail =
        parseFloat(style.getPropertyValue("--timeline-person-width")) || 226;
      const rowHeight =
        parseFloat(style.getPropertyValue("--timeline-row-height")) || 64;
      const width = scroll.clientWidth;
      const height = scroll.clientHeight;
      const scrollTop = scroll.scrollTop;
      currentScrollLeft.current = scroll.scrollLeft;
      const previousHeight = metrics.current.rowHeight;
      metrics.current = { height, rowHeight };
      const resizedRows =
        rowsRef.current.length > VIRTUAL_ROW_THRESHOLD &&
        previousHeight !== rowHeight;
      const top = resizedRows
        ? (scrollTop * rowHeight) / previousHeight
        : scrollTop;
      const pad = `${Math.max(0, (width - rail) / 2)}px`;
      const viewportHeight = `${height}px`;
      if (scroll.style.getPropertyValue("--timeline-pad") !== pad)
        scroll.style.setProperty("--timeline-pad", pad);
      if (
        scroll.style.getPropertyValue("--timeline-viewport-height") !==
        viewportHeight
      )
        scroll.style.setProperty("--timeline-viewport-height", viewportHeight);
      if (resizedRows) scroll.scrollTop = top;
      syncViewport(top);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [syncViewport]);

  useEffect(() => {
    const ids = new Set(visibleRowIds ? visibleRowIds.split("\u0000") : []);
    const update = window.setTimeout(() => {
      if (model.rows.length > VIRTUAL_ROW_THRESHOLD) setWindowed(true);
      captureScrollAnchor();
      const scroll = viewport.current;
      const previousRows = rowsRef.current;
      const previousWindow = timelineRowWindow(
        previousRows.length,
        scroll?.scrollTop ?? 0,
        metrics.current.height,
        metrics.current.rowHeight,
      );
      const retainedIds = new Set(
        previousRows
          .filter(
            ({ row }, index) =>
              previousRows.length <= VIRTUAL_ROW_THRESHOLD ||
              (index >= previousWindow.start && index < previousWindow.end) ||
              row.person.id === focusedPersonRef.current,
          )
          .map(({ row }) => row.person.id),
      );
      setRenderedRows((previous) => {
        const next = model.rows
          .filter(
            (row) => ids.has(row.person.id) || retainedIds.has(row.person.id),
          )
          .map((row) => ({ row, exiting: !ids.has(row.person.id) }));
        return previous.length === next.length &&
          previous.every(
            (item, index) =>
              item.row === next[index].row &&
              item.exiting === next[index].exiting,
          )
          ? previous
          : next;
      });
    }, 0);
    const remove = window.setTimeout(() => {
      captureScrollAnchor();
      setRenderedRows((current) =>
        current.some(({ exiting }) => exiting)
          ? current.filter(({ exiting }) => !exiting)
          : current,
      );
    }, 260);
    return () => {
      window.clearTimeout(update);
      window.clearTimeout(remove);
    };
  }, [model, visibleRowIds, captureScrollAnchor]);

  useEffect(() => {
    const prune = window.setTimeout(() => {
      setOpenEvents((previous) => {
        const next = new Set(
          [...previous].filter((key) => {
            const separator = key.lastIndexOf("\u0000");
            const id = key.slice(0, separator),
              groupYear = Number(key.slice(separator + 1));
            const row = visibleRows[rowPositions.get(id) ?? -1];
            return (
              groupYear <= year &&
              row?.groups.some((group) => group.year === groupYear)
            );
          }),
        );
        return next.size === previous.size ? previous : next;
      });
    }, 0);
    return () => window.clearTimeout(prune);
  }, [rowPositions, visibleRows, year]);

  useLayoutEffect(() => {
    rowsRef.current = renderedRows;
    if (
      focusedPersonRef.current &&
      !renderedRows.some(
        ({ row, exiting }) =>
          row.person.id === focusedPersonRef.current && !exiting,
      )
    ) {
      viewport.current?.focus({ preventScroll: true });
      focusedPersonRef.current = null;
      setFocusedPerson(null);
    }
    const scroll = viewport.current;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (scroll && anchor && virtualized) {
      const index = renderedRows.findIndex(
        ({ row }) => row.person.id === anchor.id,
      );
      if (index >= 0) {
        const top = 86 + index * metrics.current.rowHeight + anchor.offset;
        // A no-op scrollTop setter would cancel an ongoing smooth focus.
        if (Math.abs(scroll.scrollTop - top) > 0.5) scroll.scrollTop = top;
      }
    }
    // The browser can clamp scrollTop after a year removes many rows.
    syncViewport();
  }, [renderedRows, virtualized, syncViewport]);

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (!scroll || !model.rows.length || initialScrollDone.current) return;
    initialScrollDone.current = true;
    scroll.scrollLeft = model.yearX(firstYear);
    // Read the actual initial position once: the browser can clamp a setter.
    currentScrollLeft.current = scroll.scrollLeft;
    setYear(firstYear);
  }, [firstYear, model]);

  useLayoutEffect(() => {
    lifelines.current = Array.from(
      board.current?.querySelectorAll<HTMLElement>(".timeline-life") || [],
    );
    revealLifelines(lifelines.current, currentScrollLeft.current);
  }, [renderedRows, model, mountedIndices]);

  useEffect(() => {
    const scroll = viewport.current;
    if (!scroll) return;
    const onWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        (event.target instanceof Element &&
          event.target.closest(".timeline-event-list"))
      )
        return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      if (!delta) return;
      cancelFocus();
      event.preventDefault();
      const overPeople =
        event.target instanceof Element &&
        event.target.closest(
          ".timeline-person, .timeline-axis-title, .timeline-era-heading",
        );
      // Keep an explicit horizontal trackpad gesture horizontal on the rail.
      const vertical =
        event.shiftKey ||
        (!!overPeople && Math.abs(event.deltaY) >= Math.abs(event.deltaX));
      const pixels =
        delta *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? vertical
              ? scroll.clientHeight
              : scroll.clientWidth
            : 1);
      if (vertical) scroll.scrollTop += pixels;
      else scroll.scrollLeft += pixels;
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, [cancelFocus]);

  useEffect(() => {
    const scroll = viewport.current;
    const label = yearLabel.current;
    if (!scroll || !label) return;
    let frame = 0;
    let previousLeft = Number.NaN;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Capture both axes before mutating the label or lifeline styles.
        // Newly mounted rows use this same position without a layout read.
        const left = scroll.scrollLeft;
        const top = scroll.scrollTop;
        currentScrollLeft.current = left;
        const next = model.yearAtX(left);
        const text = String(next);
        if (label.textContent !== text) label.textContent = text;
        syncViewport(top);
        const pending = pendingHorizontalFocus.current;
        if (pending && Math.abs(left - pending.left) <= 1) {
          pendingHorizontalFocus.current = null;
          setHorizontalFocusReady(pending.token);
        }
        if (left !== previousLeft) {
          previousLeft = left;
          revealLifelines(lifelines.current, previousLeft);
        }
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
  }, [model, syncViewport]);

  useEffect(() => {
    const id = focusId;
    if (
      !id ||
      focusToken === undefined ||
      focusToken === lastHorizontalFocusToken.current
    )
      return;
    const scroll = viewport.current;
    const person = people.find((item) => item.id === id);
    if (!scroll || !person?.birth) return;
    lastHorizontalFocusToken.current = focusToken;
    const left = model.yearX(Number(person.birth.slice(0, 4)));
    pendingHorizontalFocus.current = { token: focusToken, left };
    scroll.scrollTo({
      left,
      behavior: scrollBehavior(),
    });
    const actualLeft = scroll.scrollLeft;
    currentScrollLeft.current = actualLeft;
    if (Math.abs(actualLeft - left) <= 1) {
      pendingHorizontalFocus.current = null;
      setHorizontalFocusReady(focusToken);
    }
  }, [focusToken, focusId, model, people]);

  useEffect(() => {
    if (
      !focusId ||
      focusToken === undefined ||
      focusToken === lastFocusedToken.current
    )
      return;
    const scroll = viewport.current;
    if (!scroll) return;
    const birthYear = model.rows.find(
      (row) => row.person.id === focusId,
    )?.birthYear;
    if (birthYear === null || birthYear === undefined) return;
    // Horizontal motion changes the year's row list. Center vertically only
    // after that list has been applied, otherwise its indices are stale.
    if (
      horizontalFocusReady !== focusToken ||
      year !== birthYear ||
      renderedRows.some(({ exiting }) => exiting) ||
      renderedRows.length !== visibleRows.length ||
      renderedRows.some(({ row }, index) => row !== visibleRows[index])
    )
      return;
    if (virtualized) {
      const index = renderedRows.findIndex(
        ({ row, exiting }) => row.person.id === focusId && !exiting,
      );
      if (index < 0) return;
      if (verticalFocusStarted.current !== focusToken) {
        verticalFocusStarted.current = focusToken;
        scroll.scrollTo({
          top: Math.max(
            0,
            86 +
              index * view.rowHeight -
              scroll.clientHeight / 2 +
              view.rowHeight / 2,
          ),
          behavior: scrollBehavior(),
        });
      }
    }
    const row = Array.from(
      board.current?.querySelectorAll<HTMLElement>(".timeline-person-row") ||
        [],
    ).find((element) => element.dataset.personId === focusId);
    if (!row) return;
    if (virtualized) {
      const bounds = row.getBoundingClientRect(),
        stage = scroll.getBoundingClientRect();
      if (bounds.bottom <= stage.top + 86 || bounds.top >= stage.bottom) return;
      lastFocusedToken.current = focusToken;
      return;
    }
    lastFocusedToken.current = focusToken;
    scroll.scrollTo({
      top: Math.max(
        0,
        row.offsetTop - scroll.clientHeight / 2 + row.clientHeight / 2,
      ),
      behavior: scrollBehavior(),
    });
  }, [
    focusToken,
    focusId,
    horizontalFocusReady,
    model,
    year,
    visibleRows,
    renderedRows,
    virtualized,
    view.rowHeight,
    mountedIndices,
  ]);

  useLayoutEffect(() => {
    const target = keyboardTarget.current;
    if (!target) return;
    const row = Array.from(
      board.current?.querySelectorAll<HTMLElement>(".timeline-person-row") ||
        [],
    ).find((element) => element.dataset.personId === target.id);
    const controls = Array.from(
      row?.querySelectorAll<HTMLElement>("button, summary") || [],
    ).filter((element) => element.getClientRects().length);
    const element = target.edge === "last" ? controls.at(-1) : controls[0];
    if (element) {
      element.focus({ preventScroll: true });
      keyboardTarget.current = null;
    }
  }, [mountedIndices]);

  const focusRow = (id: string, edge: "first" | "last" = "first") => {
    const scroll = viewport.current;
    const index = renderedRows.findIndex(({ row }) => row.person.id === id);
    if (!scroll || index < 0) return;
    cancelFocus();
    keyboardTarget.current = { id, edge };
    focusedPersonRef.current = id;
    setFocusedPerson(id);
    scroll.scrollTo({
      top: Math.max(
        0,
        86 +
          index * view.rowHeight -
          scroll.clientHeight / 2 +
          view.rowHeight / 2,
      ),
      behavior: "instant",
    });
    syncViewport();
  };

  const currentEventCount = useMemo(
    () =>
      visibleRows.reduce(
        (total, row) =>
          total +
          (row.groups.find((group) => group.year === year)?.items.length || 0),
        0,
      ),
    [visibleRows, year],
  );
  const stepYear = (delta: number) => {
    cancelFocus();
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
      <div className={`timeline-center-marker${year > model.currentYear ? " is-future" : ""}`}>
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
          {year > model.currentYear && <strong>Будущее · </strong>}
          {counted(visibleRows.length, ["человек", "человека", "человек"])} ·{" "}
          {counted(currentEventCount, ["событие", "события", "событий"])}
        </span>
      </div>
      <div
        ref={viewport}
        className="horizontal-timeline"
        role="region"
        aria-label="Горизонтальная хронология людей и событий. Колесо над карточками — список людей, над шкалой — годы. Shift и колесо — список людей"
        tabIndex={0}
        data-timeline-people={visibleRows.length}
        data-timeline-mounted={mountedIndices.length}
        onFocusCapture={(event) => {
          const id =
            (event.target as HTMLElement).closest<HTMLElement>(
              "[data-person-id]",
            )?.dataset.personId ?? null;
          focusedPersonRef.current = id;
          setFocusedPerson(id);
        }}
        onBlurCapture={(event) => {
          const id =
            (event.relatedTarget as HTMLElement | null)?.closest?.<HTMLElement>(
              "[data-person-id]",
            )?.dataset.personId ?? null;
          focusedPersonRef.current = id;
          setFocusedPerson(id);
        }}
        onKeyDown={(event) => {
          if (virtualized && event.key === "Tab") {
            const target = event.target as HTMLElement;
            const row = target.closest<HTMLElement>(".timeline-person-row");
            const position = row?.dataset.personId
              ? rowPositions.get(row.dataset.personId)
              : undefined;
            const controls = Array.from(
              row?.querySelectorAll<HTMLElement>("button, summary") || [],
            ).filter((element) => element.getClientRects().length);
            if (
              position !== undefined &&
              target === (event.shiftKey ? controls[0] : controls.at(-1))
            ) {
              const next = visibleRows[position + (event.shiftKey ? -1 : 1)];
              if (
                next &&
                !mountedIndices.some(
                  (index) =>
                    renderedRows[index].row.person.id === next.person.id,
                )
              ) {
                event.preventDefault();
                focusRow(next.person.id, event.shiftKey ? "last" : "first");
                return;
              }
            }
          }
          if (
            virtualized &&
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            (event.target as HTMLElement).classList.contains("timeline-person")
          ) {
            const id = (event.target as HTMLElement).closest<HTMLElement>(
              "[data-person-id]",
            )?.dataset.personId;
            const position = id ? rowPositions.get(id) : undefined;
            if (position !== undefined) {
              event.preventDefault();
              const next =
                visibleRows[position + (event.key === "ArrowDown" ? 1 : -1)];
              if (next) focusRow(next.person.id);
            }
            return;
          }
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            cancelFocus();
            event.preventDefault();
            event.currentTarget.scrollBy({
              left:
                (event.key === "ArrowRight" ? 1 : -1) *
                (event.shiftKey ? 120 : 12),
              behavior: scrollBehavior(),
            });
          } else if (event.key === "Home" || event.key === "End") {
            cancelFocus();
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
            cancelFocus();
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
                  <div className="timeline-emblem">
                    <img
                      src={emblems[era.name]}
                      alt=""
                      loading="lazy"
                      draggable={false}
                    />
                  </div>
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
              <div
                className="timeline-future-range"
                style={{
                  left: `calc(var(--timeline-pad) + ${model.yearX(model.currentYear)}px)`,
                  width: model.yearX(model.end) - model.yearX(model.currentYear),
                }}
              >
                <strong>Будущее</strong>
                <small>{model.currentYear + 1}–{model.end}</small>
              </div>
              <span
                className="timeline-present"
                style={{ left: `calc(var(--timeline-pad) + ${model.yearX(model.currentYear)}px)` }}
              >
                Сейчас · {model.currentYear}
              </span>
              {model.ticks.map((tick) => (
                <span
                  key={tick.year}
                  style={{ left: `calc(var(--timeline-pad) + ${tick.x}px)` }}
                >
                  {tick.year}
                </span>
              ))}
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
          <div
            className={`timeline-rows${virtualized ? " is-virtualized" : ""}`}
            role="list"
            aria-label="Люди выбранного года"
          >
            {mountedIndices.map((index, slot) => {
              const { row, exiting } = renderedRows[index];
              return (
                <Fragment key={row.person.id}>
                  {virtualized &&
                    index > (slot ? mountedIndices[slot - 1] + 1 : 0) && (
                      <div
                        className="timeline-row-spacer"
                        aria-hidden="true"
                        style={{
                          height:
                            (index -
                              (slot ? mountedIndices[slot - 1] + 1 : 0)) *
                            view.rowHeight,
                        }}
                      />
                    )}
                  <TimelinePersonRow
                    row={row}
                    exiting={exiting}
                    selected={selected.includes(row.person.id)}
                    year={year}
                    model={model}
                    count={visibleRows.length}
                    position={(rowPositions.get(row.person.id) ?? index) + 1}
                    openEvents={openEvents}
                    onChoose={onChoose}
                    changeOpenEvent={changeOpenEvent}
                  />
                </Fragment>
              );
            })}
            {virtualized && (
              <div
                className="timeline-row-spacer"
                aria-hidden="true"
                style={{
                  height:
                    (renderedRows.length - (mountedIndices.at(-1) ?? -1) - 1) *
                    view.rowHeight,
                }}
              />
            )}
          </div>
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
                  onClick={() => {
                    cancelFocus();
                    viewport.current?.scrollTo({
                      left: era.x + era.width / 2,
                      behavior: scrollBehavior(),
                    });
                  }}
                  title={`${era.name} · ${Math.max(model.start, era.start)}–${Math.min(model.end, era.end)}`}
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
