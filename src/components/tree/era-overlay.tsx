import { useReactFlow, useViewport } from "@xyflow/react";
import {
  ERAS,
  END_YEAR,
  yearY,
  centuryLabel,
  type TreeGeometry,
} from "../../domain";
export function EraOverlay({
  geometry,
  reverse,
}: {
  geometry: TreeGeometry;
  reverse: boolean;
}) {
  const viewport = useViewport(),
    flow = useReactFlow();
  const y = (year: number) =>
    viewport.y +
    (geometry.offset + yearY(year, geometry.start, reverse)) * viewport.zoom;
  const centuries = Array.from(
    { length: Math.ceil((END_YEAR - geometry.start) / 100) + 1 },
    (_, i) => Math.floor(geometry.start / 100) * 100 + i * 100,
  ).filter((v) => v >= geometry.start && v <= END_YEAR);
  return (
    <>
      <div className="flow-era-bands" aria-hidden="true">
        {ERAS.filter((e) => e.end > geometry.start && e.start < END_YEAR).map(
          (e) => {
            const top = Math.min(
                y(Math.max(geometry.start, e.start)),
                y(Math.min(END_YEAR, e.end)),
              ),
              height = Math.abs(
                y(Math.min(END_YEAR, e.end)) -
                  y(Math.max(geometry.start, e.start)),
              );
            return (
              <div key={e.name} style={{ top, height, background: e.color }} />
            );
          },
        )}
      </div>
      <aside className="flow-era-rail" aria-label="Века и эпохи">
        {geometry.offset > 0 && (
          <span className="flow-undated-label" style={{ top: viewport.y }}>
            Без дат
          </span>
        )}
        {ERAS.filter((e) => e.end > geometry.start && e.start < END_YEAR).map(
          (e) => {
            const a = y(Math.max(geometry.start, e.start)),
              b = y(Math.min(END_YEAR, e.end)),
              top = Math.min(a, b),
              height = Math.abs(b - a);
            return (
              <div
                className="flow-era-block"
                key={e.name}
                style={{ top, height, borderColor: e.color }}
              >
                <button
                  onClick={() =>
                    void flow.setViewport({
                      ...viewport,
                      y:
                        100 -
                        (geometry.offset +
                          yearY(
                            Math.max(geometry.start, e.start),
                            geometry.start,
                            reverse,
                          )) *
                          viewport.zoom,
                    })
                  }
                >
                  {e.short}
                </button>
              </div>
            );
          },
        )}
        {centuries.map((year) => (
          <span className="flow-century" key={year} style={{ top: y(year) }}>
            {centuryLabel(Math.floor(year / 100) + 1)} век
          </span>
        ))}
      </aside>
    </>
  );
}
