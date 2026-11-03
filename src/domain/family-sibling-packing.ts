import type { TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { FAMILY_ROW_GAP } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import { translateFamilyBlocks } from "./family-row-moves.ts";

/** Reunite separated sibling households and reclaim gaps in the changed part
 * of their row. Keep both sibling order and unrelated household order stable.
 * These are proposals only: the caller checks complete routing and family axes. */
export function* packedSiblingRows(geometry: TreeGeometry, size: TreeNodeSize) {
  if (geometry.mode !== "generations" || geometry.positions.length > 600)
    return;
  const rows = placedFamilyRows(geometry, size);
  const owner = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const levels = new Map(
    rows.flatMap((row, i) => row.map((b) => [b.id, i] as const)),
  );
  const groups = new Map<string, { level: number; children: Set<string> }>();
  for (const edge of geometry.branches || []) {
    if (!edge.id.startsWith("child:")) continue;
    const parent = owner.get(edge.source),
      child = owner.get(edge.target);
    const level = child ? levels.get(child) : undefined;
    if (!parent || !child || level === undefined) continue;
    const key = JSON.stringify([parent, edge.union, level]);
    const group = groups.get(key) || { level, children: new Set<string>() };
    group.children.add(child);
    groups.set(key, group);
  }
  let budget = 128;
  for (const { level, children } of groups.values()) {
    const row = rows[level];
    if (children.size < 2 || row.length > 64) continue;
    const indices = row.flatMap((b, i) => (children.has(b.id) ? [i] : []));
    const lo = indices[0],
      hi = indices.at(-1)!;
    if (hi - lo + 1 === indices.length) continue;
    const segment = row.slice(lo, hi + 1);
    for (const siblingsFirst of [true, false]) {
      const ordered = [...row];
      const siblings = segment.filter((b) => children.has(b.id));
      const others = segment.filter((b) => !children.has(b.id));
      ordered.splice(
        lo,
        segment.length,
        ...(siblingsFirst
          ? [...siblings, ...others]
          : [...others, ...siblings]),
      );
      const changed = row.flatMap((b, i) =>
        b.id !== ordered[i].id ? [i] : [],
      );
      if (!changed.length) continue;
      // Include an adjacent household as an alternative: it may be the other
      // parent of a marriage below, whose long incoming line also needs room.
      for (const extend of [0, 1]) {
        const first = Math.max(0, changed[0] - (siblingsFirst ? 0 : extend));
        const last = Math.min(
          row.length - 1,
          changed.at(-1)! + (siblingsFirst ? extend : 0),
        );
        const slice = ordered.slice(first, last + 1);
        if (
          slice.length > 24 ||
          slice.reduce((n, b) => n + b.members.length, 0) > 48
        )
          continue;
        const width =
          slice.reduce((n, b) => n + b.width, 0) +
          FAMILY_ROW_GAP * (slice.length - 1);
        const left = first
          ? row[first - 1].x + row[first - 1].width + FAMILY_ROW_GAP
          : row[first].x;
        const right =
          last + 1 < row.length
            ? row[last + 1].x - FAMILY_ROW_GAP
            : row[last].x + row[last].width;
        if (left + width > right) continue;
        const starts = new Set([
          left,
          right - width,
          Math.max(left, Math.min(row[first].x, right - width)),
        ]);
        for (const start of starts) {
          if (budget-- <= 0) return;
          let x = start;
          const deltas = new Map<string, number>();
          for (const block of slice) {
            deltas.set(block.id, x - block.x);
            x += block.width + FAMILY_ROW_GAP;
          }
          if ([...deltas.values()].some((dx) => Math.abs(dx) > size.width * 24))
            continue;
          yield translateFamilyBlocks(geometry, deltas);
        }
      }
    }
  }
}
