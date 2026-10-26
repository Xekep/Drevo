export type ScreenCard = {
  id: string;
  x: number;
  y: number;
  size: number;
  distance: number;
};
export type CardPlacement<T extends ScreenCard = ScreenCard> = T & {
  anchorX: number;
  anchorY: number;
};
export type CardOffset = { dx: number; dy: number; scale: number };
type Rect = { left: number; right: number; top: number; bottom: number };
export const SPATIAL_CARD_PROBES = 96;
export const SPATIAL_FRAME_PROBES = 12_000;
const CELL = 64;

export function spatialCardBounds(
  card: Pick<ScreenCard, "x" | "y" | "size">,
  padding = 0,
): Rect {
  return {
    left: card.x - card.size * 0.46 - padding,
    right: card.x + card.size * 0.46 + padding,
    top: card.y - card.size * 0.445 - padding,
    bottom: card.y + card.size * (card.size > 110 ? 0.525 : 0.405) + padding,
  };
}

/** Camera-only label placement. No person, world point or connection is changed.
 * Near people win; displaced labels keep a short leader back to their anchor.
 * All people survive even if the viewport cannot fit every minimum-size label.
 */
export function placeSpatialCards<T extends ScreenCard>(
  cards: readonly T[],
  width: number,
  height: number,
  previous: ReadonlyMap<string, CardOffset> = new Map(),
  anchorId?: string,
) {
  const cells = new Map<string, Rect[]>(),
    placed = new Map<string, CardPlacement<T>>();
  let probes = 0,
    unresolved = 0;
  let remaining = SPATIAL_FRAME_PROBES;
  const keys = (rect: Rect, visit: (key: string) => boolean) => {
    for (
      let x = Math.floor(rect.left / CELL);
      x <= Math.floor(rect.right / CELL);
      x++
    )
      for (
        let y = Math.floor(rect.top / CELL);
        y <= Math.floor(rect.bottom / CELL);
        y++
      )
        if (visit(`${x}:${y}`)) return true;
    return false;
  };
  const intersects = (rect: Rect) =>
    keys(rect, (key) =>
      (cells.get(key) || []).some(
        (other) =>
          rect.left < other.right &&
          rect.right > other.left &&
          rect.top < other.bottom &&
          rect.bottom > other.top,
      ),
    );
  const reserve = (rect: Rect) =>
    keys(rect, (key) => {
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(rect);
      return false;
    });
  const ordered = [...cards].sort(
    (a, b) =>
      Number(b.id === anchorId) - Number(a.id === anchorId) ||
      a.distance - b.distance ||
      a.id.localeCompare(b.id),
  );
  for (const card of ordered) {
    const original: CardPlacement<T> = {
      ...card,
      anchorX: card.x,
      anchorY: card.y,
    };
    // Do not drag off-screen world points into a pile along the screen boundary.
    if (card.x < 0 || card.x > width || card.y < 0 || card.y > height) {
      const edge = spatialCardBounds(original, 2);
      if (
        edge.right > 0 &&
        edge.left < width &&
        edge.bottom > 0 &&
        edge.top < height
      )
        reserve(edge);
      placed.set(card.id, original);
      continue;
    }
    let result: CardPlacement<T> | undefined;
    let tried = 0;
    const tryPlace = (dx: number, dy: number, size: number) => {
      if (tried && remaining <= 0) return;
      if (tried) remaining--;
      if (tried++ >= SPATIAL_CARD_PROBES) return;
      probes++;
      const candidate = { ...original, x: card.x + dx, y: card.y + dy, size };
      const rect = spatialCardBounds(candidate, 2);
      // Existing edge cards may remain partially visible; new offsets stay inside.
      if (
        (dx || dy) &&
        (rect.left < 2 ||
          rect.right > width - 2 ||
          rect.top < 2 ||
          rect.bottom > height - 2)
      )
        return;
      if (!intersects(rect)) result = candidate;
    };
    tryPlace(0, 0, card.size);
    const old = previous.get(card.id),
      maxShift = Math.min(220, width * 0.4, height * 0.4);
    if (!result && old && Math.hypot(old.dx, old.dy) <= maxShift)
      tryPlace(old.dx, old.dy, Math.max(18, card.size * old.scale));
    let seed = 2166136261;
    for (const char of card.id)
      seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
    const phase = ((seed >>> 0) / 4294967296) * Math.PI * 2;
    for (const scale of [1, 0.8, 0.6]) {
      if (result || remaining <= 0) break;
      const size = Math.max(18, card.size * scale);
      if (scale !== 1) tryPlace(0, 0, size);
      const cellWidth = size * 0.92 + 5,
        cellHeight = size * (size > 110 ? 0.97 : 0.85) + 5;
      // Explore the whole permitted disk, even for tiny overview cards. Align
      // candidate footprints to a common grid instead of repeatedly colliding
      // in the same narrow ring around an already crowded family.
      for (
        let probe = 0;
        probe < 32 && !result && tried < SPATIAL_CARD_PROBES && remaining > 0;
        probe++
      ) {
        const radius = maxShift * Math.sqrt((probe + 1) / 32),
          angle = phase + probe * 2.399963229728653;
        const x =
          Math.round((card.x + Math.cos(angle) * radius) / cellWidth) *
          cellWidth;
        const y =
          Math.round((card.y + Math.sin(angle) * radius) / cellHeight) *
          cellHeight;
        const dx = x - card.x,
          dy = y - card.y;
        if (Math.hypot(dx, dy) <= maxShift) tryPlace(dx, dy, size);
      }
    }
    if (!result) {
      result = original;
      unresolved++;
    }
    placed.set(card.id, result);
    reserve(spatialCardBounds(result, 2));
  }
  return {
    cards: cards.map((card) => placed.get(card.id)!),
    probes,
    unresolved,
  };
}
