import type { TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { FAMILY_DISPLAY_GAP } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import { translateFamilyBlocks, familyRowNoWorse } from "./family-row-moves.ts";
import { createGeometryContactScorer } from "./union-layout.ts";

export const MAX_LOCAL_SPACE_BLOCKS = 8;
export const MAX_LOCAL_SPACE_CARDS = 32;
const MAX_SEGMENTS = 12000;
const MAX_INDEX_CELLS = 500000;

/** Open one partner slot by pushing a bounded chain of whole households.
 * Other rows and the anchor stay fixed. The normal growth planner validates
 * the new family against this scene and publishes only a complete edit.
 */
export function* localFamilySpace(
  geometry: TreeGeometry,
  anchorId: string,
  size: TreeNodeSize,
  fixedPeople: ReadonlySet<string> = new Set(),
) {
  if (!geometry.occurrences || !geometry.branches || !geometry.generationBands)
    return;
  const known = new Set(geometry.occurrences.map((o) => o.id));
  if (
    geometry.branches.some((b) => !known.has(b.source) || !known.has(b.target))
  )
    return;
  const rows = placedFamilyRows(geometry, size);
  const row = rows.find((r) =>
    r.some((b) => b.members.length === 1 && b.members[0] === anchorId),
  );
  if (
    !row ||
    row.some((b, i) => i > 0 && b.x < row[i - 1].x + row[i - 1].width)
  )
    return;
  const index = row.findIndex((b) => b.members[0] === anchorId),
    anchor = row[index];
  const occurrences = new Map(geometry.occurrences!.map((o) => [o.id, o]));
  const points = new Map(geometry.positions);
  const anchorY = points.get(anchorId)!.y;
  const plans: { deltas: Map<string, number>; cost: number }[] = [];
  for (const side of [1, -1]) {
    const deltas = new Map<string, number>();
    let cursor =
      side === 1
        ? anchor.x + 2 * size.width + 32 + FAMILY_DISPLAY_GAP
        : anchor.x - size.width - 32 - FAMILY_DISPLAY_GAP;
    let count = 0,
      cost = 0,
      safe = true;
    for (let i = index + side; i >= 0 && i < row.length; i += side) {
      const block = row[i];
      const delta =
        side === 1
          ? Math.max(0, cursor - block.x)
          : Math.min(0, cursor - block.x - block.width);
      if (!delta) break;
      count += block.members.length;
      if (
        deltas.size >= MAX_LOCAL_SPACE_BLOCKS ||
        count > MAX_LOCAL_SPACE_CARDS ||
        Math.abs(delta) > 2 * size.width + 32 ||
        block.members.some(
          (id) =>
            fixedPeople.has(id) ||
            fixedPeople.has(occurrences.get(id)!.personId) ||
            Math.abs(points.get(id)!.y - anchorY) >=
              size.height + FAMILY_DISPLAY_GAP / 2,
        )
      ) {
        safe = false;
        break;
      }
      deltas.set(block.id, delta);
      cost += Math.abs(delta) * block.members.length;
      cursor =
        side === 1
          ? block.x + delta + block.width + FAMILY_DISPLAY_GAP
          : block.x + delta - FAMILY_DISPLAY_GAP;
    }
    if (safe && deltas.size) plans.push({ deltas, cost });
  }
  if (!plans.length) return;
  // Bound the full anchor score too. Very long or dense routes keep the normal
  // full-solve path rather than creating an unbounded spatial index here.
  let segments = 0,
    cells = 0;
  for (const route of [
    ...geometry.branches!.map((b) => b.route),
    ...(geometry.routes || []).map(([, r]) => r),
  ]) {
    if (
      route.points.length < 2 ||
      route.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    )
      return;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i];
      cells +=
        (Math.abs(Math.floor(a.x / 300) - Math.floor(b.x / 300)) + 1) *
        (Math.abs(Math.floor(a.y / 300) - Math.floor(b.y / 300)) + 1);
      if (++segments > MAX_SEGMENTS || cells > MAX_INDEX_CELLS) return;
    }
  }
  const scorer = createGeometryContactScorer(size.width, size.height);
  const score = (g: TreeGeometry) => ({
    ...scorer.quality(g),
    cardHits: scorer.cardContacts(g),
    overlaps: scorer.cardOverlaps(g),
  });
  let before: ReturnType<typeof score> | undefined;
  for (const { deltas } of plans.sort((a, b) => a.cost - b.cost)) {
    const move = translateFamilyBlocks(geometry, deltas);
    // Old sibling underlays need a separate projection update; do not leave
    // them behind or detach the endpoints of an unusual pair route.
    if (
      geometry.siblingGroups?.some((g) =>
        g.members.some((id) => move.moved.has(id)),
      ) ||
      geometry.branches!.some(
        (b) =>
          b.id.startsWith("pair:") &&
          (deltas.get(occurrences.get(b.source)!.block) || 0) !==
            (deltas.get(occurrences.get(b.target)!.block) || 0),
      )
    )
      continue;
    before ??= score(geometry);
    if (!familyRowNoWorse(score(move.geometry), before)) continue;
    yield { ...move.geometry, coveredRelations: undefined };
  }
}
