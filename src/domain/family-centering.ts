import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import {
  FAMILY_DISPLAY_GAP,
  type TreeNodeSize,
} from "./tree-layout-constants.ts";
import {
  familyBranchMoves,
  FAMILY_BRANCH_LIMITS,
} from "./family-branch-moves.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  familyRowNoWorse,
  routeFamilyMove,
  type FamilyRowScore,
} from "./family-row-moves.ts";
import { routeRelationships } from "./edge-routing.ts";
import { bundleFamilyBranches } from "./family-branch-bundling.ts";

/** One family is one vote; a large sibling group must not outweigh every other family. */
function familyCenters(geometry: TreeGeometry) {
  const owner = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const families = new Map<
    string,
    {
      parent: number;
      left: number;
      right: number;
      blocks: Set<string>;
      parents: Set<string>;
    }
  >();
  for (const branch of geometry.branches || []) {
    if (!branch.id.startsWith("child:")) continue;
    const block = owner.get(branch.target),
      source = owner.get(branch.source),
      first = branch.route.points[0],
      last = branch.route.points.at(-1);
    if (!block || !source || !first || !last) continue;
    const family = families.get(branch.union) || {
      parent: first.x,
      left: last.x,
      right: last.x,
      blocks: new Set<string>(),
      parents: new Set<string>(),
    };
    family.left = Math.min(family.left, last.x);
    family.right = Math.max(family.right, last.x);
    family.blocks.add(block);
    family.parents.add(source);
    families.set(branch.union, family);
  }
  return [...families].map(([id, family]) => ({
    id,
    blocks: [...family.blocks],
    parents: [...family.parents],
    preferredShift: family.parent - (family.left + family.right) / 2,
  }));
}

function centeringError(geometry: TreeGeometry) {
  return familyCenters(geometry).reduce(
    (sum, family) => sum + Math.abs(family.preferredShift),
    0,
  );
}

function crowding(geometry: TreeGeometry, size: TreeNodeSize) {
  return placedFamilyRows(geometry, size).reduce(
    (sum, row) =>
      sum +
      row
        .slice(1)
        .reduce(
          (n, block, i) =>
            n +
            Math.max(
              0,
              FAMILY_DISPLAY_GAP - (block.x - row[i].x - row[i].width),
            ),
          0,
        ),
    0,
  );
}

/** Center complete sibling forests in available space, preserving their internal geometry. */
export function centerFamilyBranches(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
): TreeGeometry {
  if (
    original.mode !== "generations" ||
    original.positions.length > 1200 ||
    !original.branches?.length
  )
    return original;
  const primary = original.routes?.length
    ? { ...original, routes: [] }
    : original;
  let best = primary;
  const initial = score(primary),
    initialCrowding = crowding(primary, size);
  let budget = original.positions.length <= 300 ? 12 : 6;
  for (let pass = 0; pass < 3 && budget > 0; pass++) {
    const before = score(best),
      beforeError = centeringError(best),
      beforeCrowding = crowding(best, size);
    const families = familyCenters(best)
      .filter((family) => Math.abs(family.preferredShift) >= size.width / 10)
      .sort(
        (a, b) =>
          Math.abs(b.preferredShift) - Math.abs(a.preferredShift) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    // Large, constrained families must not monopolize every bounded pass.
    // Reach later families before reconsidering an already attempted root.
    const offset =
      (pass * Math.floor(FAMILY_BRANCH_LIMITS.roots / 2)) %
      Math.max(1, families.length);
    const ordered = [...families.slice(offset), ...families.slice(0, offset)];
    const roots = ordered.flatMap((family) => [
      { blocks: family.blocks, preferredShift: family.preferredShift },
      {
        blocks: family.parents,
        preferredShift: -family.preferredShift,
        direction: "ancestors" as const,
      },
    ]);
    const candidates = familyBranchMoves(best, size, roots)
      .map((move) => ({
        move,
        error: centeringError(move.geometry),
        quality: score(move.geometry),
      }))
      .filter(
        ({ move, error, quality }) =>
          error < beforeError - size.width / 20 &&
          familyRowNoWorse(quality, before) &&
          crowding(move.geometry, size) <= beforeCrowding + 0.01,
      )
      .sort(
        (a, b) =>
          a.error - b.error ||
          a.quality.length - b.quality.length ||
          Number(a.move.direction === "ancestors") -
            Number(b.move.direction === "ancestors") ||
          a.move.distance - b.move.distance,
      );
    let selected: TreeGeometry | undefined,
      selectedError = beforeError;
    for (const { move } of candidates.slice(0, Math.min(6, budget))) {
      budget--;
      const candidate = bundleFamilyBranches(
          routeFamilyMove(move, size, move.preserved),
        ),
        next = score(candidate),
        error = centeringError(candidate);
      if (
        !familyRowNoWorse(next, before) ||
        !familyRowNoWorse(next, initial) ||
        next.length > Math.min(initial.length, before.length) * 1.02 ||
        next.bends > before.bends + 2 ||
        error >= selectedError - size.width / 20 ||
        crowding(candidate, size) >
          Math.min(initialCrowding, beforeCrowding) + 0.01
      )
        continue;
      selected = candidate;
      selectedError = error;
    }
    if (selected) best = selected;
  }
  if (best === primary) return original;
  if (!links.length) return best;
  const byId = new Map(people.map((p) => [p.id, p]));
  const occurrences: LayoutPerson[] = (best.occurrences || []).map((o) => ({
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
