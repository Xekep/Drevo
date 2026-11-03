import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { FAMILY_ROW_GAP } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import { visitRouteCrossings } from "./route-crossing-index.ts";
import { familyAxisQuality } from "./family-axis.ts";
import {
  translateFamilyBlocks,
  routeFamilyMove,
  type FamilyRowScore,
} from "./family-row-moves.ts";
import { finishColdFamilyLayout } from "./family-layout-candidates.ts";
import { refineColdPlacement } from "./family-row-order.ts";
import { routeRelationships } from "./edge-routing.ts";

/** A marriage joins two ancestral families. Reversing their order can require
 * moving both rows before any individual move improves the crossing count. */
export function jointFamilyMoves(geometry: TreeGeometry, size: TreeNodeSize) {
  if (geometry.positions.length > 600 || !geometry.generationBands?.length)
    return [];
  const rows = placedFamilyRows(geometry, size);
  const blocks = new Map(rows.flat().map((b) => [b.id, b]));
  const level = new Map(
    rows.flatMap((row, i) => row.map((b) => [b.id, i] as const)),
  );
  const owner = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const children = new Map<string, Set<string>>(),
    parents = new Map<string, Set<string>>();
  const edges = (geometry.branches || []).filter((b) =>
    b.id.startsWith("child:"),
  );
  for (const edge of edges) {
    const a = owner.get(edge.source),
      b = owner.get(edge.target);
    if (!a || !b || level.get(a) === undefined || level.get(b) === undefined)
      return [];
    if (level.get(a)! >= level.get(b)!) return [];
    if (!children.has(a)) children.set(a, new Set());
    if (!parents.has(b)) parents.set(b, new Set());
    children.get(a)!.add(b);
    parents.get(b)!.add(a);
  }
  const pairs = new Map<string, [string, string]>();
  visitRouteCrossings(
    edges.map((e) => ({ ...e, group: e.union })),
    (h, v) => {
      let a = owner.get(h.edge.source!),
        b = owner.get(v.edge.source!);
      if (!a || !b || a === b || level.get(a) !== level.get(b)) return;
      if (blocks.get(a)!.x > blocks.get(b)!.x) [a, b] = [b, a];
      if (![...(children.get(a) || [])].some((id) => children.get(b)?.has(id)))
        return;
      pairs.set(JSON.stringify([a, b]), [a, b]);
    },
  );
  const moves = [];
  for (const [a, b] of pairs.values()) {
    if (moves.length >= 6) break;
    const first = level.get(a)!;
    const flags = new Map<string, number>([
      [a, 1],
      [b, 2],
    ]);
    for (const [root, bit] of [
      [a, 1],
      [b, 2],
    ] as const)
      for (const id of children.get(root) || [])
        flags.set(id, (flags.get(id) || 0) | bit);
    if (
      [...flags].some(([id]) => level.get(id)! > first + 1) ||
      flags.size > 32
    )
      continue;
    const deltas = new Map<string, number>();
    // The common household goes between the two sibling forests. Keep each
    // forest's internal order and every unrelated household's relative order.
    for (const row of rows.slice(first, first + 2)) {
      const active = row.filter((block) => flags.has(block.id));
      const rank = (id: string) => ({ 2: 0, 3: 1, 1: 2 })[flags.get(id)!] ?? 3;
      active.sort((x, y) => rank(x.id) - rank(y.id));
      let next = 0,
        x = row[0].x;
      row.forEach((old, i) => {
        const block = flags.has(old.id) ? active[next++] : old;
        deltas.set(block.id, x - block.x);
        x += block.width + (row[i + 1] ? row[i + 1].x - old.x - old.width : 0);
      });
    }
    // Center the two parents on their newly ordered children simultaneously;
    // an intermediate crossing is not grounds for rejecting the whole plan.
    const upper = [...rows[first]].sort(
      (x, y) => x.x + (deltas.get(x.id) || 0) - y.x - (deltas.get(y.id) || 0),
    );
    upper.forEach((block, i) => {
      if (block.id !== a && block.id !== b) return;
      const anchors = edges
        .filter((e) => owner.get(e.source) === block.id)
        .map(
          (e) =>
            e.route.points.at(-1)!.x +
            (deltas.get(owner.get(e.target)!) || 0) -
            (e.route.points[0].x - block.x),
        )
        .sort((x, y) => x - y);
      if (!anchors.length) return;
      const desired =
        (anchors[Math.floor((anchors.length - 1) / 2)] +
          anchors[Math.floor(anchors.length / 2)]) /
        2;
      const left = upper[i - 1],
        right = upper[i + 1];
      const lo = left
        ? left.x + (deltas.get(left.id) || 0) + left.width + FAMILY_ROW_GAP
        : -Infinity;
      const hi = right
        ? right.x + (deltas.get(right.id) || 0) - block.width - FAMILY_ROW_GAP
        : Infinity;
      deltas.set(block.id, Math.max(lo, Math.min(hi, desired)) - block.x);
    });
    let valid = true;
    const ancestry = new Set<string>();
    for (const root of [a, b]) {
      const queue = [root],
        seen = new Set(queue),
        dx = deltas.get(root) || 0;
      for (let i = 0; i < queue.length && valid; i++)
        for (const id of parents.get(queue[i]) || []) {
          if (seen.has(id)) continue;
          if (ancestry.has(id) || id === a || id === b || queue.length >= 32) {
            valid = false;
            break;
          }
          seen.add(id);
          ancestry.add(id);
          queue.push(id);
          deltas.set(id, dx);
        }
    }
    if (!valid) continue;
    const move = translateFamilyBlocks(geometry, deltas);
    if (move.moved.size > 80) continue;
    const preserved = new Set(
      (geometry.branches || [])
        .filter(
          (edge) =>
            (deltas.get(owner.get(edge.source)!) || 0) ===
            (deltas.get(owner.get(edge.target)!) || 0),
        )
        .map((edge) => edge.id),
    );
    moves.push({ ...move, preserved });
  }
  return moves;
}

/** Fewer crossings must preserve family alignment as well as safe routing. */
export function preferJointFamilyLayout(
  candidate: TreeGeometry,
  current: TreeGeometry,
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  const a = score(candidate),
    b = score(current);
  if (
    a.crossings >= b.crossings ||
    a.contacts > b.contacts ||
    a.cardHits > b.cardHits ||
    a.overlaps > b.overlaps ||
    a.length > b.length * 1.05 ||
    a.bends > b.bends + 4
  )
    return false;
  const next = familyAxisQuality(candidate, size),
    before = familyAxisQuality(current, size);
  return (
    next.interleavings <= before.interleavings &&
    next.maxOffset <= before.maxOffset + 0.01 &&
    next.offset <= before.offset + 0.01 &&
    next.single <= before.single + 0.01 &&
    next.lineageDrift <= before.lineageDrift + 0.01 &&
    next.lineageSpan <= before.lineageSpan + 0.01
  );
}

export function optimizeJointFamilyOrder(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  if (!score(original).crossings) return original;
  const primary = original.routes?.length
    ? { ...original, routes: [] }
    : original;
  let best = primary;
  for (const move of jointFamilyMoves(primary, size)) {
    if (score(move.geometry).overlaps) continue;
    let candidate = finishColdFamilyLayout(
      routeFamilyMove(move, size, move.preserved),
      people,
      [],
      size,
      score,
    );
    if (
      score(candidate).crossings > score(primary).crossings ||
      score(candidate).cardHits > score(primary).cardHits
    )
      continue;
    // Reorient the connecting couple only after both ancestral rows moved.
    candidate = refineColdPlacement(candidate, people, [], size, score);
    if (preferJointFamilyLayout(candidate, best, size, score)) best = candidate;
  }
  if (best === primary) return original;
  if (!links.length) return best;
  const byId = new Map(people.map((p) => [p.id, p]));
  const occurrences = (best.occurrences || []).map((o) => ({
    id: o.id,
    birth: byId.get(o.personId)?.birth || "",
    parents: [],
    spouses: [],
  }));
  const routes = routeRelationships(
    occurrences,
    links,
    best.positions,
    size.width,
    size.height,
    new Set(),
    (best.branches || []).map((b) => ({ group: b.union, route: b.route })),
  );
  if (routes.length !== (original.routes || []).length) return original;
  const result = { ...best, routes };
  return score(result).cardHits <= score(original).cardHits ? result : original;
}
