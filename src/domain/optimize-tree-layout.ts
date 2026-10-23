import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import { treeNodeSize } from "./tree-layout-constants.ts";
import { createGeometryContactScorer } from "./union-layout.ts";
import { refineColdPlacement } from "./family-row-order.ts";
import { familyRowNoWorse } from "./family-row-moves.ts";
import { bundleFamilyBranches } from "./family-branch-bundling.ts";

export type TreeOptimization = {
  changed: boolean;
  before: { crossings: number; contacts: number };
  after: { crossings: number; contacts: number };
};

/** Explicit, bounded refinement of the displayed projection, not saved person data. */
export function optimizeDisplayedTree(
  original: TreeGeometry, people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
): { geometry: TreeGeometry; optimization: TreeOptimization } {
  if (original.mode !== "generations") throw new Error("Оптимизация доступна в обычном 2D-древе.");
  if (original.positions.length > 1600)
    throw new Error("Для оптимизации выберите ветвь или включите показ фрагмента до 1600 карточек.");
  const size = original.nodeSize || treeNodeSize();
  const scorer = createGeometryContactScorer(size.width, size.height);
  const primaryViews = new WeakMap<TreeGeometry, TreeGeometry>();
  const score = (geometry: TreeGeometry) => {
    let g = geometry;
    if (geometry.routes?.length) {
      g = primaryViews.get(geometry) || { ...geometry, routes: [] };
      primaryViews.set(geometry, g);
    }
    return { ...scorer.quality(g), cardHits: scorer.cardContacts(g), overlaps: scorer.cardOverlaps(g) };
  };
  // Additional ties never decide where the primary family is placed.
  const before = score(original);
  let best = original;
  for (let pass = 0; pass < 2; pass++) {
    const candidate = bundleFamilyBranches(refineColdPlacement(best, people, links, size,
      score));
    const next = score(candidate);
    const current = score(best);
    if (!familyRowNoWorse(next, before) || !familyRowNoWorse(next, current)) break;
    const ys = new Map(original.positions.map(([id, point]) => [id, point.y]));
    if (candidate.positions.length !== ys.size || candidate.positions.some(([id, p]) =>
      ys.get(id) !== p.y || !Number.isFinite(p.x))) break;
    if (next.crossings >= current.crossings && next.contacts >= current.contacts &&
        next.cardHits >= current.cardHits && next.overlaps >= current.overlaps &&
        next.length >= current.length - 1) break;
    best = candidate;
  }
  const after = score(best);
  return { geometry: best, optimization: {
    changed: best !== original,
    before: { crossings: before.crossings, contacts: before.contacts },
    after: { crossings: after.crossings, contacts: after.contacts },
  } };
}
