import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { familyBlockConflicts } from "./local-family-order.ts";
import { familyBranchMoves } from "./family-branch-moves.ts";
import { mirroredFamilyBranches } from "./family-branch-mirror.ts";
import { routeFamilyMove, type FamilyRowScore } from "./family-row-moves.ts";
import { routeRelationships } from "./edge-routing.ts";
import {
  finishColdFamilyLayout,
  preferFamilyLayout,
  refineFinalCoupleOrder,
} from "./family-layout-candidates.ts";

/** Cold alternatives for independent sides of connected families. Accepted
 * proposals are checked as complete scenes, using only geometry and relations.
 * Existing slots remain untouched on edits. */
export function optimizeFinalFamilyBranches(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  if (people.length > 600 || !score(original).crossings) return original;
  const primary = original.routes?.length
    ? { ...original, routes: [] }
    : original;
  let best = primary,
    budget = 4;
  for (let pass = 0; pass < 2 && budget > 0; pass++) {
    const before = best;
    const roots = [...familyBlockConflicts(best).contacts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([id]) => ({
        blocks: [id],
        preferredShift: 0,
        stopAtSharedChildren: true,
      }));
    const shifts = familyBranchMoves(best, size, roots);
    const mirrors = mirroredFamilyBranches(best, size);
    const ranked = [...shifts, ...mirrors]
      .filter((m) => !score(m.geometry).overlaps)
      .sort(
        (a, b) =>
          score(a.geometry).crossings - score(b.geometry).crossings ||
          score(a.geometry).contacts - score(b.geometry).contacts ||
          score(a.geometry).length - score(b.geometry).length ||
          a.distance - b.distance,
      );
    // Divide the allowance between rounds so a successful reflection can expose
    // a translation that did not help in the original scene.
    const cap = Math.min(budget, 2);
    let selected = best;
    for (const move of ranked.slice(0, cap)) {
      budget--;
      const routed = routeFamilyMove(move, size, move.preserved);
      const quality = score(routed),
        current = score(before);
      if (
        quality.cardHits > current.cardHits ||
        quality.overlaps > current.overlaps ||
        quality.crossings > current.crossings
      )
        continue;
      const finished = finishColdFamilyLayout(routed, people, [], size, score);
      // Evaluate the uncentered route too: centering can add avoidable bends.
      for (const candidate of [routed, finished])
        if (
          preferFamilyLayout(candidate, selected, size, score) &&
          preferFamilyLayout(candidate, primary, size, score)
        )
          selected = candidate;
    }
    // Reorient only the selected proposal, not every discarded candidate.
    // This keeps the extra search bounded on the first opening of the tree.
    const refined = refineFinalCoupleOrder(selected, people, [], size, score);
    if (
      preferFamilyLayout(refined, selected, size, score) &&
      preferFamilyLayout(refined, primary, size, score)
    )
      selected = refined;
    best = selected;
    if (best === before || !score(best).crossings) break;
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
  return preferFamilyLayout(result, original, size, score) ? result : original;
}
