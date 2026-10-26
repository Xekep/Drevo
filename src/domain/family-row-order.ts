import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { routeRelationships } from "./edge-routing.ts";
import {
  familyBlockConflicts,
  placedFamilyRows,
} from "./local-family-order.ts";
import { familyBranchMoves } from "./family-branch-moves.ts";
import { restoreFamilyRowHistory } from "./family-row-history.ts";
import { optimizeMultiPartnerOrder } from "./multi-partner-order.ts";
import { coupleBlocksWithContactedAncestry, locallyReverseCouples } from "./local-couple-order.ts";
import {
  translateFamilyBlocks as translate,
  reorderFamilyRow as reordered,
  routeFamilyMove as routeMove,
  familyRowNoWorse as safer,
  FAMILY_ROW_GAP as GAP,
  type FamilyRowMove as Move,
  type FamilyRowScore as Score,
  type FamilyRowQuality as Quality,
} from "./family-row-moves.ts";

/** Empty space between blocks, not the total width or the size of cards. */
function emptySpace(geometry: TreeGeometry, size: TreeNodeSize) {
  return placedFamilyRows(geometry, size).reduce(
    (sum, row) =>
      sum +
      row
        .slice(1)
        .reduce(
          (cost, block, i) =>
            cost +
            Math.max(0, block.x - row[i].x - row[i].width - size.width * 2) **
              2,
          0,
        ),
    0,
  );
}

function shifts(geometry: TreeGeometry, size: TreeNodeSize): Move[] {
  const result: Move[] = [];
  for (const row of placedFamilyRows(geometry, size))
    for (let i = 0; i < row.length; i++) {
      const block = row[i],
        members = new Set(block.members),
        anchors: number[] = [];
      for (const branch of geometry.branches || []) {
        if (!branch.id.startsWith("child:")) continue;
        const first = branch.route.points[0],
          last = branch.route.points.at(-1)!;
        if (members.has(branch.source))
          anchors.push(block.x + last.x - first.x);
        if (members.has(branch.target))
          anchors.push(block.x + first.x - last.x);
      }
      if (!anchors.length) continue;
      anchors.sort((a, b) => a - b);
      const desired = Math.max(
        anchors[Math.floor((anchors.length - 1) / 2)],
        Math.min(block.x, anchors[Math.floor(anchors.length / 2)]),
      );
      const lower = i ? row[i - 1].x + row[i - 1].width + GAP : -Infinity;
      const upper = row[i + 1] ? row[i + 1].x - block.width - GAP : Infinity;
      if (lower > upper) continue;
      const x = Math.max(lower, Math.min(upper, desired));
      if (Math.abs(x - block.x) < size.width / 20) continue;
      result.push(translate(geometry, new Map([[block.id, x - block.x]])));
    }
  return result;
}

/** Small, cold alternative placements may need their own spouse orientation. */
export function refineColdPlacement(
  original: TreeGeometry, people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[], size: TreeNodeSize, score: Score,
) {
  let best = original;
  const initial = score(original);
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const id of coupleBlocksWithContactedAncestry(best, size.width).slice(0, 64)) {
      const candidate = locallyReverseCouples(best, people, links, size, new Set([id]));
      if (!candidate) continue;
      const next = score(candidate), current = score(best);
      if (!safer(next, current) || !safer(next, initial) || next.crossings >= current.crossings) continue;
      best = candidate;
      changed = true;
    }
    if (!changed) break;
  }
  return optimizeMultiPartnerOrder(optimizeFamilyRows(best, people, links, size, score), people, links, size, score);
}

/** A bounded cold-layout pass: order within generations first, then close unused gaps. */
export function optimizeFamilyRows(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: Score,
  previous?: TreeGeometry,
): TreeGeometry {
  if (original.positions.length > 1600) return original;
  const primary = original.routes?.length
    ? { ...original, routes: [] }
    : original;
  let best = primary;
  const initial = score(primary),
    small = people.length <= 300;
  if (previous) {
    const retained = restoreFamilyRowHistory(
      primary,
      previous,
      people,
      size,
      score,
    );
    if (retained === primary) return original;
    best = retained;
  }
  let budget = small ? 24 : 8;
  let cheapCandidates = 0;
  for (let pass = 0; !previous && pass < 2 && budget > 0; pass++) {
    const before = score(best),
      { contacts, crossed } = familyBlockConflicts(best);
    if (!before.crossings || !contacts.size) break;
    const candidates: { move: Move; quality: Quality }[] = [];
    const seen = new Set<string>();
    for (const row of placedFamilyRows(best, size)) {
      if (row.length < 2 || row.length > 64) continue;
      // Moving this row can only change its incident branches. A crossing
      // between two untouched branches cannot disappear after rerouting.
      if (!row.some((block) => crossed.has(block.id))) continue;
      const active = row
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => contacts.has(block.id))
        .sort((a, b) => contacts.get(b.block.id)! - contacts.get(a.block.id)!);
      for (const { index: from } of active)
        for (let step = 1; step < row.length; step++) {
          for (const to of [from - step, from + step]) {
            if (to < 0 || to >= row.length) continue;
            if (candidates.length >= (small ? 512 : 128)) break;
            const order = row.map((b) => b.id);
            order.splice(to, 0, ...order.splice(from, 1));
            const key = JSON.stringify(order);
            if (seen.has(key)) continue;
            seen.add(key);
            const move = reordered(best, row, from, to);
            if (move) candidates.push({ move, quality: score(move.geometry) });
          }
        }
    }
    cheapCandidates += candidates.length;
    candidates.sort(
      (a, b) =>
        a.quality.cardHits - b.quality.cardHits ||
        a.quality.crossings - b.quality.crossings ||
        a.quality.contacts - b.quality.contacts ||
        a.move.distance - b.move.distance,
    );
    let selected: TreeGeometry | undefined;
    for (const { move } of candidates.slice(0, small ? 12 : 8)) {
      if (budget-- <= 0) break;
      const candidate = routeMove(move, size),
        next = score(candidate);
      if (
        !safer(next, before) ||
        !safer(next, initial) ||
        next.crossings >= before.crossings
      )
        continue;
      if (
        !selected ||
        next.crossings < score(selected).crossings ||
        (next.crossings === score(selected).crossings &&
          next.length < score(selected).length)
      )
        selected = candidate;
    }
    if (!selected) break;
    best = selected;
  }
  let reorderBudget = budget;
  budget = small ? 8 : 4;
  for (let pass = 0; !previous && pass < 3 && budget > 0; pass++) {
    const before = score(best),
      beforeGaps = emptySpace(best, size);
    const candidates = shifts(best, size).sort(
      (a, b) =>
        score(a.geometry).cardHits - score(b.geometry).cardHits ||
        score(a.geometry).length - score(b.geometry).length ||
        emptySpace(a.geometry, size) - emptySpace(b.geometry, size),
    );
    let selected: TreeGeometry | undefined;
    for (const move of candidates) {
      if (budget-- <= 0) break;
      const candidate = routeMove(move, size),
        next = score(candidate);
      if (
        !safer(next, before) ||
        !safer(next, initial) ||
        next.bends > before.bends + 2
      )
        continue;
      const shorter = next.length < before.length - size.width / 10;
      const fewerGaps =
        beforeGaps > 0 &&
        emptySpace(candidate, size) < beforeGaps * 0.9 &&
        next.length <= before.length * 1.02;
      if (!shorter && !fewerGaps) continue;
      if (
        !selected ||
        next.length < score(selected).length ||
        (next.length === score(selected).length &&
          emptySpace(candidate, size) < emptySpace(selected, size))
      )
        selected = candidate;
    }
    if (!selected) break;
    best = selected;
  }
  // A successful row move can still leave a conflict spanning generations.
  // Continue with rigid descendant moves within the same unspent allowance.
  if (!previous && score(best).crossings) {
    const { contacts, crossed } = familyBlockConflicts(best);
    const branchRoots = [...contacts].filter(([id]) => crossed.has(id))
      .sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const cap = Math.min(small ? 32 : 8, (small ? 1024 : 128) - cheapCandidates);
    const borrowed = reorderBudget <= 0 && !small;
    const routeLimit = Math.min(small ? 12 : 2, borrowed ? budget : reorderBudget);
    if (cap > 0 && routeLimit > 0) {
      const before = score(best);
      const candidates = familyBranchMoves(best, size, branchRoots, cap)
        .map((move) => ({ move, quality: score(move.geometry) }))
        .filter(({ quality }) => safer(quality, before) && safer(quality, initial) &&
          quality.crossings < before.crossings)
        .sort((a, b) => a.quality.crossings - b.quality.crossings ||
          a.quality.contacts - b.quality.contacts || a.quality.length - b.quality.length ||
          a.move.distance - b.move.distance);
      let selected: TreeGeometry | undefined;
      for (const { move } of candidates.slice(0, routeLimit)) {
        if (borrowed) budget--;
        else reorderBudget--;
        const candidate = routeMove(move, size, move.preserved), next = score(candidate);
        if (!safer(next, before) || !safer(next, initial) || next.crossings >= before.crossings) continue;
        if (!selected || next.crossings < score(selected).crossings ||
            (next.crossings === score(selected).crossings && next.length < score(selected).length))
          selected = candidate;
      }
      if (selected) best = selected;
    }
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
