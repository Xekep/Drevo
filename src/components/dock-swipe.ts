/** Жест только за заголовок: короткое касание и боковое движение не закрывают карточку. */
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
