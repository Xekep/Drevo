import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  familyRowNoWorse,
  routeFamilyMove,
  translateFamilyBlocks,
  type FamilyRowScore,
  type FamilyRowMove,
} from "./family-row-moves.ts";
import { routeRelationships, simplifyRoute } from "./edge-routing.ts";

const COMPACT_GAP = 32;

function compactMove(
  geometry: TreeGeometry,
  deltas: Map<string, number>,
  owners: ReadonlyMap<string, string>,
): FamilyRowMove {
  const moved = translateFamilyBlocks(geometry, deltas);
  return {
    ...moved,
    geometry: {
      ...moved.geometry,
      branches: geometry.branches!.map((branch, index) => {
        const points = branch.route.points,
          a = points[0],
          b = points.at(-1)!;
        const from = deltas.get(owners.get(branch.source)!) || 0;
        const to = deltas.get(owners.get(branch.target)!) || 0;
        if (from !== to && a.x === b.x) return moved.geometry.branches![index];
        return {
          ...branch,
          route: {
            ...branch.route,
            points: simplifyRoute(
              points.map((p) => ({
                ...p,
                x:
                  p.x +
                  from +
                  (from === to ? 0 : ((p.x - a.x) / (b.x - a.x)) * (to - from)),
              })),
            ),
          },
        };
      }),
    },
  };
}

/** Move aligned generations together instead of independently folding every
 * child route into a new elbow. Preserve existing obstacle-avoidance lanes.
 */
function coordinatedCompaction(
  original: TreeGeometry,
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  const rows = placedFamilyRows(original, size);
  const blocks = rows.flat();
  if (blocks.length < 2) return original;
  const owners = new Map(original.occurrences!.map((o) => [o.id, o.block]));
  const roots = new Map(blocks.map((b) => [b.id, b.id]));
  const root = (id: string) => {
    while (roots.get(id) !== id) id = roots.get(id)!;
    return id;
  };
  // Straight ancestor columns and partners form rigid horizontal groups.
  for (const branch of original.branches!) {
    const points = branch.route.points;
    if (
      !branch.id.startsWith("pair:") &&
      !points.every((p) => p.x === points[0].x)
    )
      continue;
    const a = owners.get(branch.source),
      b = owners.get(branch.target);
    if (a && b && roots.has(a) && roots.has(b)) roots.set(root(b), root(a));
  }
  const groups = new Map<string, { left: number; right: number }>();
  for (const b of blocks) {
    const id = root(b.id),
      group = groups.get(id) || { left: Infinity, right: -Infinity };
    group.left = Math.min(group.left, b.x);
    group.right = Math.max(group.right, b.x + b.width);
    groups.set(id, group);
  }
  const center =
    (Math.min(...blocks.map((b) => b.x)) +
      Math.max(...blocks.map((b) => b.x + b.width))) /
    2;
  const before = score(original);
  let best = original,
    span = treeRowSpan(original, size);
  for (const factor of [0.5, 0.65, 0.8, 0.9, 0.95, 0.98]) {
    const deltas = new Map(
      blocks.map((b) => {
        const group = groups.get(root(b.id))!;
        return [b.id, ((group.left + group.right) / 2 - center) * (factor - 1)];
      }),
    );
    if (
      original.branches!.some(
        (branch) =>
          branch.id.startsWith("pair:") &&
          (deltas.get(owners.get(branch.source)!) || 0) !==
            (deltas.get(owners.get(branch.target)!) || 0),
      )
    )
      continue;
    if (
      rows.some((row) =>
        row.slice(1).some((b, i) => {
          const a = row[i],
            gap = b.x - a.x - a.width;
          return (
            gap + deltas.get(b.id)! - deltas.get(a.id)! <
            Math.min(COMPACT_GAP, gap) - 0.01
          );
        }),
      )
    )
      continue;
    const candidate = compactMove(original, deltas, owners).geometry;
    const candidateSpan = treeRowSpan(candidate, size);
    if (
      candidateSpan < span - 1 &&
      familyRowNoWorse(score(candidate), before)
    ) {
      best = candidate;
      span = candidateSpan;
    }
  }
  return best;
}

export function treeRowSpan(geometry: TreeGeometry, size: TreeNodeSize) {
  return placedFamilyRows(geometry, size).reduce(
    (sum, row) =>
      sum + (row.length ? row.at(-1)!.x + row.at(-1)!.width - row[0].x : 0),
    0,
  );
}

/** Explicit horizontal packing. Keep card sizes, spouse order and generation Y.
 * Coordinated rows are tried first; partial moves retain the same safety score.
 */
export function compactTreeLayout(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  if (
    !original.occurrences ||
    !original.branches ||
    !original.generationBands ||
    original.siblingGroups?.length ||
    (original.routes?.length && !links.length)
  )
    return original;
  let best = coordinatedCompaction(original, size, score),
    budget = 32,
    reroutes = 6;
  const initial = score(original);
  const owners = new Map(original.occurrences.map((o) => [o.id, o.block]));
  for (let pass = 0; pass < 2 && budget > 0; pass++) {
    const rows = placedFamilyRows(best, size).filter(
      (row) =>
        row.length > 1 &&
        row.every((b, i) => !i || b.x >= row[i - 1].x + row[i - 1].width),
    );
    const plans = rows
      .map((row) => {
        let cursor = row[0].x;
        const target = row.map((block, i) => {
          const x = cursor;
          cursor +=
            block.width +
            (row[i + 1]
              ? Math.min(COMPACT_GAP, row[i + 1].x - block.x - block.width)
              : 0);
          return x;
        });
        const offset = (row.at(-1)!.x - target.at(-1)!) / 2;
        const deltas = new Map(
          row.map((block, i) => [block.id, target[i] + offset - block.x]),
        );
        const saving = row.at(-1)!.x - target.at(-1)!;
        return { deltas, saving };
      })
      .filter((plan) => plan.saving > 1)
      .sort((a, b) => b.saving - a.saving);
    if (!plans.length) break;
    const all = new Map(plans.flatMap((p) => [...p.deltas]));
    const before = score(best),
      span = treeRowSpan(best, size);
    let chosen: TreeGeometry | undefined;
    for (const deltas of [all, ...plans.slice(0, 12).map((p) => p.deltas)]) {
      for (const fraction of [1, 0.5]) {
        if (budget-- <= 0) break;
        const shifts = new Map(
          [...deltas].map(([id, dx]) => [id, dx * fraction]),
        );
        if (
          best.branches!.some(
            (b) =>
              b.id.startsWith("pair:") &&
              (shifts.get(owners.get(b.source)!) || 0) !==
                (shifts.get(owners.get(b.target)!) || 0),
          )
        )
          continue;
        const move = compactMove(best, shifts, owners);
        let candidate = move.geometry,
          quality = score(candidate);
        if (
          (!familyRowNoWorse(quality, before) ||
            !familyRowNoWorse(quality, initial)) &&
          reroutes > 0 &&
          best.branches!.filter(
            (b) => move.moved.has(b.source) || move.moved.has(b.target),
          ).length <= 128
        ) {
          reroutes--;
          candidate = routeFamilyMove(move, size);
          quality = score(candidate);
        }
        if (
          !familyRowNoWorse(quality, before) ||
          !familyRowNoWorse(quality, initial) ||
          treeRowSpan(candidate, size) >= span - 1
        )
          continue;
        if (!chosen || treeRowSpan(candidate, size) < treeRowSpan(chosen, size))
          chosen = candidate;
      }
      if (budget <= 0) break;
    }
    if (!chosen) break;
    best = chosen;
  }
  if (best === original || !links.length) return best;
  const byId = new Map(people.map((p) => [p.id, p]));
  const occurrences: LayoutPerson[] = best.occurrences!.map((o) => ({
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
    best.branches!.map((b) => ({ group: b.union, route: b.route })),
  );
  if (routes.length !== original.routes?.length) return original;
  return { ...best, routes };
}
