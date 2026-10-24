import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  familyRowNoWorse,
  routeFamilyMove,
  translateFamilyBlocks,
  type FamilyRowScore,
} from "./family-row-moves.ts";
import { routeRelationships } from "./edge-routing.ts";

const COMPACT_GAP = 32;

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
  let best = original,
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
        const move = translateFamilyBlocks(best, shifts);
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
