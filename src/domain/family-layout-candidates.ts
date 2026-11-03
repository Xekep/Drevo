import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { spaceFamilyRows } from "./family-row-spacing.ts";
import { bundleFamilyBranches } from "./family-branch-bundling.ts";
import { centerFamilyBranches } from "./family-centering.ts";
import { alignFamilyLineages } from "./lineage-alignment.ts";
import { familyAxisQuality } from "./family-axis.ts";
import { familyRowNoWorse, type FamilyRowScore } from "./family-row-moves.ts";
import {
  coupleBlocksWithContactedAncestry,
  locallyReverseCouples,
} from "./local-couple-order.ts";

/** Final centering changes incoming corridors; recheck affected pairs without
 * moving family blocks or spending another ELK solve. Only cold layouts use this. */
export function refineFinalCoupleOrder(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  if (people.length > 1200 || !score(original).crossings) return original;
  let best = original,
    budget = people.length <= 300 ? 24 : 8;
  for (let pass = 0; pass < 2 && budget > 0; pass++) {
    const before = best;
    for (const id of coupleBlocksWithContactedAncestry(best, size.width)) {
      if (budget-- <= 0) break;
      const candidate = locallyReverseCouples(
        best,
        people,
        links,
        size,
        new Set([id]),
        true,
      );
      if (!candidate || score(candidate).crossings >= score(best).crossings)
        continue;
      // Bound the entire pass against its input as well: successive changes
      // must not accumulate extra bends or trade away the strict family axes.
      if (
        preferFamilyLayout(candidate, best, size, score) &&
        preferFamilyLayout(candidate, original, size, score)
      )
        best = candidate;
    }
    if (best === before || !score(best).crossings) break;
  }
  return best;
}

/** All cold alternatives are judged after the same spacing, routing and axis passes. */
export function finishColdFamilyLayout(
  geometry: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  const spaced = spaceFamilyRows(geometry, size, score);
  const bundled = bundleFamilyBranches(bundleFamilyBranches(spaced));
  const centered = centerFamilyBranches(bundled, people, links, size, score);
  return alignFamilyLineages(centered, people, links, size, score);
}

/** Keep the incumbent unless the complete proposal is safe and more readable. */
export function preferFamilyLayout(
  candidate: TreeGeometry,
  current: TreeGeometry,
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  const next = score(candidate),
    before = score(current);
  if (!familyRowNoWorse(next, before)) return false;
  const a = familyAxisQuality(candidate, size),
    b = familyAxisQuality(current, size);
  if (
    a.interleavings > b.interleavings ||
    a.offset > b.offset + 0.01 ||
    a.single > b.single + 0.01 ||
    a.maxOffset > b.maxOffset + 0.01 ||
    a.lineageDrift > b.lineageDrift + 0.01 ||
    a.lineageSpan > b.lineageSpan + 0.01
  )
    return false;
  if (next.crossings < before.crossings || next.contacts < before.contacts)
    return true;
  if (next.length > before.length * 1.02) return false;
  return (
    a.interleavings < b.interleavings ||
    a.lineageDrift < b.lineageDrift - size.width / 20 ||
    a.offset < b.offset - size.width / 20 ||
    (next.bends < before.bends && next.length <= before.length) ||
    (next.length < before.length - size.width / 20 &&
      next.bends <= before.bends)
  );
}
