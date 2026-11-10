import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { horizontalTimeline } from "../../domain/horizontal-timeline";

type Model = ReturnType<typeof horizontalTimeline>;

/** Maps the visible dates onto the equal-width era segments. */
export function TimelineEraNavigation({ model, year, viewport, onNavigate }: {
  model: Model;
  year: number;
  viewport: RefObject<HTMLDivElement | null>;
  onNavigate: (year: number) => void;
}) {
  const bar = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [halfWidth, setHalfWidth] = useState(0);
  const activeEra = model.eras.find((era, index) => year >= era.start &&
    (year < era.end || (index === model.eras.length - 1 && year === era.end)))?.name;

  useEffect(() => {
    if (preview === null) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [preview]);

  useEffect(() => {
    const scroll = viewport.current;
    if (!scroll) return;
    const measure = () => {
      const rail = parseFloat(getComputedStyle(scroll).getPropertyValue("--timeline-person-width"));
      setHalfWidth(Math.max(0, (scroll.clientWidth - rail) / 2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [viewport]);

  useLayoutEffect(() => {
    const nav = bar.current;
    const button = nav?.querySelector<HTMLElement>("[aria-current]");
    if (!nav || !button) return;
    const reveal = () => {
      const left = button.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
      if (left < nav.scrollLeft ||
        left + button.offsetWidth > nav.scrollLeft + nav.clientWidth)
        nav.scrollLeft = left - (nav.clientWidth - button.offsetWidth) / 2;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeEra, model.eras]);

  const positionAt = (date: number) => {
    const index = model.eras.findIndex((era) => date < Math.min(model.end, era.end));
    if (index < 0) return 100;
    const era = model.eras[index];
    const start = Math.max(model.start, era.start);
    const end = Math.min(model.end, era.end);
    return (index + Math.max(0, (date - start) / (end - start))) / model.eras.length * 100;
  };
  const center = model.yearX(preview ?? year);
  const first = model.yearAtX(center - halfWidth);
  const last = model.yearAtX(center + halfWidth);
  const left = positionAt(first);
  const right = positionAt(last);
  return (
    <div className="timeline-era-navigation">
      <nav ref={bar} className="timeline-era-bar" aria-label="Переход к исторической эпохе"
        onScroll={() => setPreview(null)}>
        <div className="timeline-era-track" style={{ minWidth: model.eras.length * 76 }}>
        {model.eras.map((era) => {
          const start = Math.max(model.start, era.start);
          const end = Math.min(model.end, era.end);
          const target = Math.round((start + end) / 2);
          const current = activeEra === era.name;
          return (
            <button type="button" key={era.name}
              className={`timeline-era-segment ${era.className}`}
              aria-current={current ? "date" : undefined}
              aria-label={`${era.name}, ${start}–${end}`}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") setPreview(target);
              }}
              onPointerLeave={() => setPreview(null)}
              onFocus={() => setPreview(target)}
              onBlur={() => setPreview(null)}
              onClick={() => { setPreview(null); onNavigate(target); }}>
              <span>{era.name === "Ранние эпохи" ? "До 1547"
                : era.name === "Русское царство" ? "Царство" : era.short}</span>
            </button>
          );
        })}
          <div className={`timeline-range-window${preview === null ? "" : " is-preview"}`}
            role="img" aria-label={`${preview === null ? "Видимый диапазон" : "Диапазон после перехода"}: ${first}–${last}`}
            style={{ left: `${left}%`, width: `${right - left}%` }}>
            <span style={{ left: `${(left + right) / 2}%`, transform: `translateX(-${(left + right) / 2}%)` }}>{first}–{last}</span>
          </div>
        </div>
      </nav>
    </div>
  );
}
