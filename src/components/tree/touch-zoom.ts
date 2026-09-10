type Point = { x: number; y: number };
export type ZoomViewport = Point & { zoom: number };
export type TimedTouch = Point & { time: number };

export function isSecondTap(previous: TimedTouch | null, next: TimedTouch) {
  return (
    !!previous &&
    next.time - previous.time >= 0 &&
    next.time - previous.time <= 300 &&
    Math.hypot(next.x - previous.x, next.y - previous.y) <= 32
  );
}

/** Одна и та же точка древа остаётся под местом второго касания. */
export function zoomAt(
  viewport: ZoomViewport,
  anchor: Point,
  factor: number,
): ZoomViewport {
  const zoom = Math.max(0.05, Math.min(1.8, viewport.zoom * factor));
  const ratio = zoom / viewport.zoom;
  return {
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio,
    zoom,
  };
}
