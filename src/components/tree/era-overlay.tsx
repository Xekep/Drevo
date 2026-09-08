import { useEffect, useRef } from "react";
import { useReactFlow, useStore, useViewport } from "@xyflow/react";
import { ChevronDown } from "lucide-react";
import { ERAS, END_YEAR, yearY, type TreeGeometry } from "../../domain";
import { timelineScale } from "../../domain/timeline-scale";

export function EraOverlay({ geometry }: { geometry: TreeGeometry }) {
  const viewport = useViewport(),
    flow = useReactFlow();
  const height = useStore((state) => state.height);
  const menu = useRef<HTMLDetailsElement>(null);
  const scale = timelineScale(geometry, viewport, height);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
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
  function goTo(year?: number) {
    if (menu.current) menu.current.open = false;
    const worldY =
      year === undefined
        ? 0
        : geometry.offset + yearY(year, geometry.start, geometry.reverse);
    void flow.setViewport({ ...viewport, y: 100 - worldY * viewport.zoom });
  }
  return (
    <>
      <div className="timeline-landscape" aria-hidden="true">
        {scale.eras.map((era) => (
          <div
            key={era.name}
            className={`timeline-wash ${era.className}`}
            style={{ top: era.top, height: era.height }}
          />
        ))}
        {scale.ticks.map((tick) => (
          <div
            key={tick.year}
            className={`timeline-year ${tick.year % 50 === 0 ? "major" : ""}`}
            style={{ top: tick.y }}
          >
            <span>{tick.year}</span>
          </div>
        ))}
        {scale.centuries.map((century) => (
          <div
            key={century.century}
            className="timeline-century-line"
            style={{ top: century.top }}
          />
        ))}
        {geometry.offset > 0 && (
          <div
            className="timeline-undated-boundary"
            style={{ top: scale.undatedEnd }}
          />
        )}
      </div>
      <aside className="timeline-rail" aria-label="Века и исторические эпохи">
        {!scale.centuries.some((century) => century.visibleHeight > 66) && (
          <nav
            className="timeline-quick-centuries"
            aria-label="Перейти к векам"
          >
            <span>К ВЕКУ</span>
            {scale.centuries.map((century) => (
              <button
                key={century.century}
                onClick={() =>
                  goTo(geometry.reverse ? century.to : century.from)
                }
                aria-label={`Перейти в ${century.label} век`}
              >
                {century.label}
              </button>
            ))}
          </nav>
        )}
        <div className="timeline-rail-sections" aria-hidden="true">
          {scale.eras.map((era) => (
            <div
              key={era.name}
              className={`timeline-rail-wash ${era.className}`}
              style={{ top: era.top, height: era.height }}
            />
          ))}
        </div>
        {geometry.offset > 0 &&
          Math.min(height, scale.undatedEnd) - Math.max(66, viewport.y) >
            110 && (
            <div
              className="timeline-undated"
              style={{ top: Math.max(92, viewport.y + 20) }}
            >
              <span>БЕЗ</span>
              <strong>дат</strong>
              <small>
                Годы можно
                <br />
                добавить позже
              </small>
            </div>
          )}
        {scale.centuries
          .filter((century) => century.visibleHeight > 66)
          .map((century) => (
            <button
              key={century.century}
              className="timeline-century"
              style={{ top: century.visibleTop + 8 }}
              onClick={() => goTo(geometry.reverse ? century.to : century.from)}
              aria-label={`Перейти в ${century.label} век`}
            >
              <strong>{century.label}</strong>
              <span>ВЕК</span>
            </button>
          ))}
        {scale.eras
          .filter((era) => era.visibleHeight >= 30)
          .map((era) => {
            const compact = era.visibleHeight < 200;
            const label = compact ? era.short : era.name;
            if (era.visibleHeight < label.length * 12 + 20) return null;
            return (
              <button
                key={era.name}
                className={`timeline-era ${era.className} ${compact ? "compact" : ""}`}
                style={{
                  top: era.visibleTop + (compact ? 5 : 18),
                  maxHeight: era.visibleHeight - 10,
                }}
                onClick={() =>
                  goTo(
                    geometry.reverse
                      ? Math.min(END_YEAR, era.end)
                      : Math.max(geometry.start, era.start),
                  )
                }
                title={`${era.name} · ${era.start}–${Math.min(era.end, END_YEAR)}`}
              >
                <span>{label}</span>
                {!compact && (
                  <small>
                    {era.start} — {era.end >= END_YEAR ? "сегодня" : era.end}
                  </small>
                )}
              </button>
            );
          })}
        <details className="timeline-period-menu" ref={menu}>
          <summary>
            Время <ChevronDown size={12} />
          </summary>
          <nav aria-label="Переход к периоду">
            <span>ВЕКА</span>
            <div className="timeline-century-links">
              {scale.centuries.map((century) => (
                <button
                  key={century.century}
                  onClick={() =>
                    goTo(geometry.reverse ? century.to : century.from)
                  }
                >
                  {century.label}
                  <small>век</small>
                </button>
              ))}
            </div>
            <span>ЭПОХИ</span>
            {ERAS.filter(
              (era) => era.end > geometry.start && era.start < END_YEAR,
            ).map((era) => (
              <button
                key={era.name}
                onClick={() =>
                  goTo(
                    geometry.reverse
                      ? Math.min(END_YEAR, era.end)
                      : Math.max(geometry.start, era.start),
                  )
                }
              >
                {era.name}
                <small>
                  {era.start} — {era.end >= END_YEAR ? "сегодня" : era.end}
                </small>
              </button>
            ))}
            {geometry.offset > 0 && (
              <button onClick={() => goTo()}>Люди без дат</button>
            )}
          </nav>
        </details>
      </aside>
    </>
  );
}
