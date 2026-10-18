import type { TreeGeometry } from "./tree-layout.ts";
import { FAMILY_DISPLAY_GAP, type TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import { familyRowNoWorse, routeFamilyMove, translateFamilyBlocks, type FamilyRowScore } from "./family-row-moves.ts";

/** Bounded readability pass after ordering: keep a row unchanged if widening harms routing. */
export function spaceFamilyRows(original: TreeGeometry, size: TreeNodeSize, score: FamilyRowScore) {
  if (!original.branches || original.positions.length > 1200) return original;
  let best = original;
  const initial = score(original);
  const rows = placedFamilyRows(original, size)
    .map((row, index) => ({ index, crowded: row.slice(1).filter((b, i) =>
      b.x - row[i].x - row[i].width < FAMILY_DISPLAY_GAP - 0.01).length }))
    .filter((row) => row.crowded)
    .sort((a, b) => b.crowded - a.crowded || a.index - b.index).slice(0, 4);
  for (const { index } of rows) {
    const row = placedFamilyRows(best, size)[index];
    if (row.length < 2 || row.length > 32 || row.reduce((n, b) => n + b.members.length, 0) > 64) continue;
    let cursor = row[0].x;
    const desired = row.map((block) => {
      const x = Math.max(block.x, cursor);
      cursor = x + block.width + FAMILY_DISPLAY_GAP;
      return x;
    });
    const offset = (desired.at(-1)! - row.at(-1)!.x) / 2;
    const deltas = new Map(row.map((block, i) => [block.id, desired[i] - block.x - offset]));
    if ([...deltas.values()].every((dx) => Math.abs(dx) < 0.01) ||
        [...deltas.values()].some((dx) => Math.abs(dx) > size.width * 2)) continue;
    const move = translateFamilyBlocks(best, deltas);
    const affected = best.branches!.filter((b) => move.moved.has(b.source) || move.moved.has(b.target));
    if (affected.length > 128) continue;
    const candidate = routeFamilyMove(move, size);
    const next = score(candidate);
    if (familyRowNoWorse(next, score(best)) && familyRowNoWorse(next, initial)) best = candidate;
  }
  return best;
}
