import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  familyPairBlocks,
  locallyReverseCouples,
} from "./local-couple-order.ts";
import {
  translateFamilyBlocks,
  routeFamilyMove,
  familyRowNoWorse,
  FAMILY_ROW_GAP,
  type FamilyRowBlock,
  type FamilyRowScore,
} from "./family-row-moves.ts";

/** Retain old horizontal slots when a local edit only inserts a new household. */
function retainedRows(
  geometry: TreeGeometry,
  previous: TreeGeometry,
  size: TreeNodeSize,
) {
  const old = new Map(previous.positions),
    current = new Map(geometry.positions);
  // One monotone mapping for all corridors preserves their relative order.
  // Stretching every edge separately can introduce crossings between old edges.
  const anchors = new Map<number, number>();
  let consistent = true;
  for (const [id, before] of old) {
    const after = current.get(id);
    if (!after) continue;
    for (const offset of [0, size.height]) {
      const y = before.y + offset,
        next = after.y + offset;
      if (anchors.has(y) && anchors.get(y) !== next) consistent = false;
      anchors.set(y, next);
    }
  }
  const levels = [...anchors].sort(([a], [b]) => a - b);
  consistent &&= levels.every(([, y], i) => !i || y > levels[i - 1][1]);
  const mapY = (y: number) => {
    let i = 1;
    while (i < levels.length - 1 && levels[i][0] < y) i++;
    const [a, b] = [levels[i - 1], levels[i]];
    return a[1] + ((y - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
  };
  const deltas = new Map<string, number>();
  for (const row of placedFamilyRows(geometry, size)) {
    const retained: { block: FamilyRowBlock; x: number }[] = [],
      fresh: FamilyRowBlock[] = [];
    for (const block of row) {
      const shifts = block.members
        .filter((id) => old.has(id))
        .map((id) => old.get(id)!.x - current.get(id)!.x);
      if (!shifts.length) {
        fresh.push(block);
        continue;
      }
      // A changed orientation or newly merged block requires the solver's order.
      if (Math.max(...shifts) - Math.min(...shifts) > 1) {
        retained.push({ block, x: block.x });
        continue;
      }
      const delta = shifts[0];
      deltas.set(block.id, delta);
      retained.push({ block, x: block.x + delta });
    }
    retained.sort((a, b) => a.x - b.x);
    for (const block of fresh) {
      const candidates = [block.x];
      for (const placed of retained)
        candidates.push(
          placed.x - FAMILY_ROW_GAP - block.width,
          placed.x + placed.block.width + FAMILY_ROW_GAP,
        );
      const fits = candidates.filter((x) =>
        retained.every(
          (placed) =>
            x + block.width + FAMILY_ROW_GAP <= placed.x ||
            x >= placed.x + placed.block.width + FAMILY_ROW_GAP,
        ),
      );
      if (!fits.length) continue;
      fits.sort(
        (a, b) => Math.abs(a - block.x) - Math.abs(b - block.x) || a - b,
      );
      deltas.set(block.id, fits[0] - block.x);
      retained.push({ block, x: fits[0] });
    }
  }
  const move = translateFamilyBlocks(geometry, deltas);
  const prior = new Map(
    (previous.branches || []).map((branch) => [branch.id, branch]),
  );
  const reused = new Set<string>();
  move.geometry.branches = move.geometry.branches?.map((branch) => {
    const before = prior.get(branch.id);
    if (
      !before ||
      before.source !== branch.source ||
      before.target !== branch.target ||
      before.union !== branch.union ||
      before.route.sourceHandle !== branch.route.sourceHandle ||
      before.route.targetHandle !== branch.route.targetHandle
    ) {
      if (branch.id.startsWith("child:")) move.moved.add(branch.target);
      return branch;
    }
    const start = branch.route.points[0],
      end = branch.route.points.at(-1)!;
    const oldStart = before.route.points[0],
      oldEnd = before.route.points.at(-1)!;
    if (start.x !== oldStart.x || end.x !== oldEnd.x || oldStart.y === oldEnd.y)
      return branch;
    const sharedCorridor =
      consistent &&
      levels.length >= 2 &&
      Math.abs(mapY(oldStart.y) - start.y) <= 1 &&
      Math.abs(mapY(oldEnd.y) - end.y) <= 1;
    // Prefer a shared mapping; independently changed generation deviations can
    // require an edge-local stretch, still subject to the final safety score.
    const points = before.route.points.map((point) => ({
      x: point.x,
      y: sharedCorridor
        ? mapY(point.y)
        : start.y +
          ((point.y - oldStart.y) * (end.y - start.y)) /
            (oldEnd.y - oldStart.y),
    }));
    reused.add(branch.id);
    return { ...branch, route: { ...branch.route, points } };
  });
  return { ...move, preserved: reused };
}

/** Recover the previous row order only when safety and edit-locality improve. */
export function restoreFamilyRowHistory(
  original: TreeGeometry,
  previous: TreeGeometry,
  people: LayoutPerson[],
  size: TreeNodeSize,
  score: FamilyRowScore,
): TreeGeometry {
  const primary = original,
    initial = score(primary);
  if (previous.mode !== original.mode || previous.reverse !== original.reverse)
    return original;
  const oldPositions = new Map(previous.positions),
    currentPositions = new Map(primary.positions);
  const reversed = new Set(
    familyPairBlocks(primary)
      .filter((block) => {
        const [a, b] = block.members;
        return (
          oldPositions.has(a) &&
          oldPositions.has(b) &&
          Math.sign(oldPositions.get(a)!.x - oldPositions.get(b)!.x) !==
            Math.sign(currentPositions.get(a)!.x - currentPositions.get(b)!.x)
        );
      })
      .map((block) => block.id),
  );
  const oriented = reversed.size
    ? locallyReverseCouples(primary, people, [], size, reversed) || primary
    : primary;
  const restored = retainedRows(oriented, previous, size);
  const candidate = routeFamilyMove(restored, size, restored.preserved);
  const old = new Map(previous.positions);
  const displacement = (geometry: TreeGeometry) => {
    const shifts = geometry.positions
      .filter(([id]) => old.has(id))
      .map(([id, point]) => point.x - old.get(id)!.x)
      .sort((a, b) => a - b);
    const center = shifts[Math.floor(shifts.length / 2)] || 0;
    return (
      shifts.reduce((sum, shift) => sum + Math.abs(shift - center), 0) /
      Math.max(1, shifts.length)
    );
  };
  let best = original;
  for (const view of [oriented, candidate]) {
    const next = score(view),
      current = score(best);
    const movement = displacement(view),
      currentMovement = displacement(best);
    const improvesContacts =
      next.crossings < current.crossings ||
      (next.crossings === current.crossings &&
        next.contacts < current.contacts);
    if (
      !familyRowNoWorse(next, initial) ||
      movement > currentMovement ||
      (movement === currentMovement && !improvesContacts)
    )
      continue;
    best = view;
  }
  // If restoring a whole row is unsafe, recover free horizontal slots one block
  // at a time. Require a crossing improvement as well as less movement, with a
  // fixed quality ceiling so an early gain does not trap later safe moves.
  if (displacement(best) > size.width / 8) {
    const ceiling = {
      ...initial,
      crossings: Math.max(0, initial.crossings - 1),
      contacts: Math.max(0, initial.contacts - 1),
    };
    let budget = 160;
    for (let pass = 0; pass < 4 && budget > 0; pass++) {
      let changed = false;
      for (const row of placedFamilyRows(best, size)) {
        for (let i = 0; i < row.length && budget > 0; i++) {
          const block = row[i],
            positions = new Map(best.positions);
          const shifts = block.members
            .filter((id) => old.has(id))
            .map((id) => old.get(id)!.x - positions.get(id)!.x)
            .sort((a, b) => a - b);
          if (!shifts.length) continue;
          const desired = block.x + shifts[Math.floor(shifts.length / 2)];
          const lower = i
            ? row[i - 1].x + row[i - 1].width + FAMILY_ROW_GAP
            : -Infinity;
          const upper = row[i + 1]
            ? row[i + 1].x - block.width - FAMILY_ROW_GAP
            : Infinity;
          if (lower > upper) continue;
          const x = Math.max(lower, Math.min(upper, desired));
          if (Math.abs(x - block.x) < 1) continue;
          budget--;
          const move = translateFamilyBlocks(
            best,
            new Map([[block.id, x - block.x]]),
          );
          const view = routeFamilyMove(move, size);
          if (
            !familyRowNoWorse(score(view), ceiling) ||
            displacement(view) >= displacement(best)
          )
            continue;
          best = view;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  return best;
}
