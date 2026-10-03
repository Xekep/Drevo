export type TimelineRowWindow = {
  start: number;
  end: number;
  before: number;
  after: number;
};

/** End is exclusive; spacers exclude the board's existing top padding. */
export function timelineRowWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 4,
  top = 86,
): TimelineRowWindow {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0)
    throw new RangeError("Timeline row height must be positive and finite");
  count = Math.max(0, Math.floor(count));
  const extra = Math.max(0, Math.floor(overscan));
  const scroll = Math.max(0, scrollTop);
  const clamp = (index: number) => Math.max(0, Math.min(count, index));
  const start = clamp(Math.floor((scroll - top) / rowHeight) - extra);
  const end = Math.max(
    start,
    clamp(
      Math.ceil((scroll + Math.max(0, viewportHeight) - top) / rowHeight) +
        extra,
    ),
  );
  return {
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
  };
}
