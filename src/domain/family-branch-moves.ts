import type { TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  FAMILY_ROW_GAP,
  translateFamilyBlocks,
  type FamilyRowMove,
} from "./family-row-moves.ts";

export type FamilyBranchMove = FamilyRowMove & { preserved: Set<string> };

export const FAMILY_BRANCH_LIMITS = {
  roots: 32,
  households: 32,
  people: 64,
  branches: 128,
  boundaryRoutes: 8,
  candidates: 32,
  perRoot: 4,
};

/** Rigid descendant translations from a household, preserving all generations. */
export function familyBranchMoves(
  geometry: TreeGeometry,
  size: TreeNodeSize,
  roots: Iterable<string>,
  limit = FAMILY_BRANCH_LIMITS.candidates,
): FamilyBranchMove[] {
  const cap = Math.max(0, Math.min(FAMILY_BRANCH_LIMITS.candidates, limit));
  if (!cap || geometry.positions.length > 1600) return [];
  const rows = placedFamilyRows(geometry, size);
  const blocks = new Map(rows.flatMap((row) => row.map((block) => [block.id, block] as const)));
  const owner = new Map((geometry.occurrences || []).map((o) => [o.id, o.block]));
  const levels = new Map((geometry.generationBands || []).flatMap((band) =>
    band.members.map((id) => [owner.get(id), band.level] as const),
  ));
  const children = new Map<string, Set<string>>();
  const invalid = new Set<string>();
  for (const branch of geometry.branches || []) {
    if (!branch.id.startsWith("child:")) continue;
    const source = owner.get(branch.source), target = owner.get(branch.target);
    if (!source || !target) return [];
    if (!blocks.has(source) || !blocks.has(target) ||
        levels.get(source) === undefined || levels.get(target) === undefined ||
        levels.get(source)! >= levels.get(target)!) {
      invalid.add(source);
      invalid.add(target);
    }
    const next = children.get(source) || new Set<string>();
    next.add(target);
    children.set(source, next);
  }
  const pending: { blocks: Set<string>; dx: number; preserved: Set<string> }[][] = [];
  const seen = new Set<string>();
  const triedRoots = new Set<string>();
  for (const root of roots) {
    if (triedRoots.has(root)) continue;
    if (triedRoots.size >= FAMILY_BRANCH_LIMITS.roots) break;
    triedRoots.add(root);
    if (!blocks.has(root)) continue;
    const closure = new Set([root]), queue = [root];
    let people = 0, valid = true;
    for (let i = 0; i < queue.length && valid; i++) {
      const id = queue[i];
      people += blocks.get(id)?.members.length || 0;
      if (invalid.has(id) || people > FAMILY_BRANCH_LIMITS.people) break;
      for (const child of children.get(id) || []) {
        if (closure.has(child)) continue;
        closure.add(child);
        queue.push(child);
        if (closure.size > FAMILY_BRANCH_LIMITS.households) { valid = false; break; }
      }
    }
    if (!valid || people > FAMILY_BRANCH_LIMITS.people ||
        [...closure].some((id) => invalid.has(id)) || closure.size < 2) continue;
    const preserved = new Set<string>(), anchors: number[] = [];
    let boundary = 0, affected = 0;
    for (const branch of geometry.branches || []) {
      const source = closure.has(owner.get(branch.source)!),
        target = closure.has(owner.get(branch.target)!);
      if (!source && !target) continue;
      if (++affected > FAMILY_BRANCH_LIMITS.branches) { valid = false; break; }
      if (source && target) preserved.add(branch.id);
      else if (!branch.id.startsWith("child:")) { valid = false; break; }
      else {
        if (++boundary > FAMILY_BRANCH_LIMITS.boundaryRoutes) { valid = false; break; }
        const first = branch.route.points[0], last = branch.route.points.at(-1)!;
        anchors.push(source ? last.x - first.x : first.x - last.x);
      }
    }
    if (!valid || affected > FAMILY_BRANCH_LIMITS.branches ||
        boundary > FAMILY_BRANCH_LIMITS.boundaryRoutes) continue;
    // A separate contour at every level lets a short neighboring branch end
    // without reserving a rectangle through all lower generations.
    const forbidden: [number, number][] = [];
    for (const row of rows) {
      const moving = row.filter((block) => closure.has(block.id));
      if (!moving.length) continue;
      const left = Math.min(...moving.map((b) => b.x)),
        right = Math.max(...moving.map((b) => b.x + b.width));
      for (const fixed of row) if (!closure.has(fixed.id))
        forbidden.push([
          fixed.x - FAMILY_ROW_GAP - right,
          fixed.x + fixed.width + FAMILY_ROW_GAP - left,
        ]);
    }
    forbidden.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const interval of forbidden) {
      const last = merged.at(-1);
      // Keep a single exactly fitting gap between touching open intervals.
      if (last && interval[0] < last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const free = (dx: number) => {
      let low = 0, high = merged.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (merged[middle][0] < dx) low = middle + 1;
        else high = middle;
      }
      return !low || dx >= merged[low - 1][1];
    };
    anchors.sort((a, b) => a - b);
    const desired = anchors.length ? anchors[Math.floor(anchors.length / 2)] : 0;
    const offsets = [...new Set([...anchors, ...merged.flat()])]
      .filter((dx) => Number.isFinite(dx) && Math.abs(dx) >= size.width / 20 &&
        Math.abs(dx) <= size.width * 24 &&
        free(dx))
      .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || Math.abs(a) - Math.abs(b) || a - b);
    const proposals: typeof pending[number] = [];
    for (const dx of offsets) {
      const key = JSON.stringify([[...closure].sort(), dx]);
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({ blocks: closure, dx, preserved });
      if (proposals.length >= FAMILY_BRANCH_LIMITS.perRoot) break;
    }
    if (proposals.length) pending.push(proposals);
  }
  // A small global budget must reach a later root before being spent on
  // alternative offsets of the first root. Materialize only returned moves.
  const result: FamilyBranchMove[] = [];
  for (let offset = 0; offset < FAMILY_BRANCH_LIMITS.perRoot; offset++)
    for (const proposals of pending) {
      const proposal = proposals[offset];
      if (!proposal) continue;
      const move = translateFamilyBlocks(geometry,
        new Map([...proposal.blocks].map((id) => [id, proposal.dx])),
      );
      result.push({ ...move, preserved: proposal.preserved });
      if (result.length >= cap) return result;
    }
  return result;
}
