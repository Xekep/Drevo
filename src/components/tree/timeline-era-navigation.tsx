import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { horizontalTimeline } from "../../domain/horizontal-timeline";

type Model = ReturnType<typeof horizontalTimeline>;

/** Owns the compact navigator's hover preview and local horizontal scrolling. */
export function TimelineEraNavigation({ model, year, viewport, onNavigate }: {
  model: Model;
  year: number;
  viewport: RefObject<HTMLDivElement | null>;
  onNavigate: (year: number) => void;
}) {
  const bar = useRef<HTMLElement>(null);
  const tooltipId = useId();
  const [preview, setPreview] = useState<{ name: string; year: number; left: number } | null>(null);
  const [halfWidth, setHalfWidth] = useState(0);
  const activeEra = model.eras.find((era, index) => year >= era.start &&
    (year < era.end || (index === model.eras.length - 1 && year === era.end)))?.name;

  useEffect(() => {
    if (!preview) return;
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
      if (button.offsetLeft < nav.scrollLeft ||
        button.offsetLeft + button.offsetWidth > nav.scrollLeft + nav.clientWidth)
        nav.scrollLeft = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeEra, model.eras]);

  const showPreview = (button: HTMLButtonElement, name: string, target: number) => {
    const bounds = button.getBoundingClientRect();
    const nav = bar.current!.getBoundingClientRect();
    setPreview({ name, year: target, left: bounds.left + bounds.width / 2 - nav.left });
  };
  const previewX = preview ? model.yearX(preview.year) : 0;
  return (
    <div className="timeline-era-navigation">
      <nav ref={bar} className="timeline-era-bar" aria-label="Переход к исторической эпохе"
        onScroll={() => setPreview(null)}>
        {model.eras.map((era) => {
          const start = Math.max(model.start, era.start);
          const end = Math.min(model.end, era.end);
          const target = Math.round((start + end) / 2);
          const current = activeEra === era.name;
          const progress = Math.max(0, Math.min(100, (year - start) / (end - start) * 100));
          return (
            <button type="button" key={era.name}
              className={`timeline-era-segment ${era.className}`}
              aria-current={current ? "date" : undefined}
              aria-label={`${era.name}, ${start}–${end}`}
              aria-describedby={preview?.name === era.name ? tooltipId : undefined}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") showPreview(event.currentTarget, era.name, target);
              }}
              onPointerLeave={() => setPreview(null)}
              onFocus={(event) => showPreview(event.currentTarget, era.name, target)}
              onBlur={() => setPreview(null)}
              onClick={() => { setPreview(null); onNavigate(target); }}>
              {current && <i className="timeline-era-position" aria-label={`На шкале: ${year}`}
                style={{ left: `${progress}%` }}>
                <b style={{ transform: `translateX(-${progress}%)` }}>{year}</b>
              </i>}
              <span>{era.name === "Ранние эпохи" ? "До 1547"
                : era.name === "Русское царство" ? "Царство" : era.short}</span>
            </button>
          );
        })}
      </nav>
      {preview && <div id={tooltipId} role="tooltip" className="timeline-era-preview"
        style={{ left: `clamp(80px, ${preview.left}px, calc(100% - 80px))` }}>
        <strong>{model.yearAtX(previewX - halfWidth)}–{model.yearAtX(previewX + halfWidth)}</strong>
        <span>Будет видно · центр {preview.year}</span>
      </div>}
    </div>
  );
}
