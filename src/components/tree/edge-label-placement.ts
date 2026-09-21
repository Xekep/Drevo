type Point = { x: number; y: number };

/** Центр самого длинного прямого участка; порядок точек идёт от source к target. */
export function edgeLabelPlacement(
  points: readonly Point[] | undefined,
  fallback: { x: number; y: number; source: Point; target: Point },
) {
  let best:
    | { x: number; y: number; vertical: boolean; reversed: boolean; length: number }
    | undefined;
  for (let i = 1; i < (points?.length || 0); i++) {
    const from = points![i - 1];
    const to = points![i];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if ((!dx && !dy) || (dx && dy)) continue;
    const length = Math.abs(dx || dy);
    if (best && length <= best.length) continue;
    best = {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      vertical: !dx,
      reversed: dx ? dx < 0 : dy < 0,
      length,
    };
  }
  if (best) return best;
  const dx = fallback.target.x - fallback.source.x;
  const dy = fallback.target.y - fallback.source.y;
  const vertical = Math.abs(dy) > Math.abs(dx);
  return {
    x: fallback.x,
    y: fallback.y,
    vertical,
    reversed: vertical ? dy < 0 : dx < 0,
    length: Math.max(Math.abs(dx), Math.abs(dy)),
  };
}
