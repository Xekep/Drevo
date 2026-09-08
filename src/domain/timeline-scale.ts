import { centuryLabel, END_YEAR, ERAS, yearAtY, yearY } from "./layout.ts";
import type { TreeGeometry } from "./tree-layout.ts";

export function timelineCenturies(start: number) {
  return Array.from(
    { length: Math.ceil(END_YEAR / 100) - Math.ceil(start / 100) + 1 },
    (_, i) => {
      const century = Math.ceil(start / 100) + i;
      return {
        century,
        label: centuryLabel(century),
        from: Math.max(start, (century - 1) * 100 + 1),
        to: Math.min(END_YEAR, century * 100 + 1),
      };
    },
  );
}

/** Экранная шкала; типографика не уменьшается вместе с карточками. */
export function timelineScale(
  geometry: Pick<TreeGeometry, "start" | "offset" | "reverse">,
  viewport: { y: number; zoom: number },
  height: number,
) {
  const project = (year: number) =>
    viewport.y +
    (geometry.offset + yearY(year, geometry.start, geometry.reverse)) *
      viewport.zoom;
  const segment = (from: number, to: number) => {
    const a = project(from),
      b = project(to),
      top = Math.min(a, b),
      bottom = Math.max(a, b);
    const visibleTop = Math.max(66, top),
      visibleBottom = Math.min(height - 18, bottom);
    return {
      top,
      bottom,
      height: bottom - top,
      visibleTop,
      visibleBottom,
      visibleHeight: Math.max(0, visibleBottom - visibleTop),
    };
  };
  const centuries = timelineCenturies(geometry.start).map((century) => ({
    ...century,
    ...segment(century.from, century.to),
  }));
  const eras = ERAS.filter(
    (era) => era.end > geometry.start && era.start < END_YEAR,
  ).map((era) => ({
    ...era,
    ...segment(
      Math.max(geometry.start, era.start),
      Math.min(END_YEAR, era.end),
    ),
  }));
  const visibleYears = [
    yearAtY(
      -viewport.y / viewport.zoom - geometry.offset,
      geometry.start,
      geometry.reverse,
    ),
    yearAtY(
      (height - viewport.y) / viewport.zoom - geometry.offset,
      geometry.start,
      geometry.reverse,
    ),
  ];
  const first = Math.max(geometry.start, Math.min(...visibleYears)),
    last = Math.min(END_YEAR, Math.max(...visibleYears));
  const step =
    [10, 25, 50, 100].find((years) => years * 8 * viewport.zoom >= 52) || 100;
  const ticks: { year: number; y: number }[] = [];
  for (let year = Math.ceil(first / step) * step; year <= last; year += step)
    ticks.push({ year, y: project(year) });
  return {
    centuries,
    eras,
    ticks,
    project,
    undatedEnd: viewport.y + geometry.offset * viewport.zoom,
  };
}
