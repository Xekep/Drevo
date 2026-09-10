/** Короткое касание и боковое движение не закрывают карточку. */
export function dockSwipeAction(
  dx: number,
  dy: number,
  elapsed: number,
  expanded: boolean,
): "close" | "expand" | "reset" {
  if (Math.abs(dy) < Math.abs(dx) * 1.4) return "reset";
  if (dy >= 72 || (dy >= 28 && dy / Math.max(elapsed, 1) >= 0.55))
    return "close";
  if (!expanded && dy <= -48) return "expand";
  return "reset";
}

/** Decide once before taking over native scrolling; keep scroll gestures native. */
export function dockSwipeIntent(
  dx: number,
  dy: number,
  atTop: boolean,
  fromHeading: boolean,
  expanded: boolean,
): "pending" | "scroll" | "drag" {
  if (Math.hypot(dx, dy) < 8) return "pending";
  if (Math.abs(dy) < Math.abs(dx) * 1.4) return "scroll";
  if (dy > 0 && (atTop || fromHeading)) return "drag";
  if (dy < 0 && fromHeading && !expanded) return "drag";
  return "scroll";
}
