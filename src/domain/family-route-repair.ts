import type { TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { familyRowNoWorse, routeFamilyMove, type FamilyRowQuality } from "./family-row-moves.ts";

export const FAMILY_ROUTE_REPAIR_LIMITS = { people: 200, candidates: 36, perGeneration: 12 };

/** Repair historical arrivals against retained cards; all other routes stay fixed. */
export function repairFamilyRoutes(
  original: TreeGeometry,
  size: TreeNodeSize,
  score: (geometry: TreeGeometry) => FamilyRowQuality & { groups: ReadonlyMap<string, number> },
  maxCandidates = FAMILY_ROUTE_REPAIR_LIMITS.candidates,
) {
  let best = original, attempts = 0;
  const byGeneration = new Map<number, number>();
  const limit = Math.max(0, Math.min(FAMILY_ROUTE_REPAIR_LIMITS.candidates, Math.floor(maxCandidates)));
  if (!limit || original.positions.length > FAMILY_ROUTE_REPAIR_LIMITS.people || original.mode !== "generations")
    return { geometry: best, attempts, byGeneration };
  const initial = score(original);
  if (!initial.crossings) return { geometry: best, attempts, byGeneration };
  let current = initial;
  const levels = new Map((original.generationBands || []).flatMap((band) =>
    band.members.map((id) => [id, band.level] as const),
  ));
  const pools = new Map<number, NonNullable<TreeGeometry["branches"]>>();
  for (const branch of original.branches || []) {
    if (!branch.id.startsWith("child:") || !initial.groups.get(branch.union)) continue;
    const level = levels.get(branch.source);
    if (level === undefined) continue;
    const pool = pools.get(level) || [];
    pool.push(branch);
    pools.set(level, pool);
  }
  for (const pool of pools.values())
    pool.sort((a, b) => initial.groups.get(b.union)! - initial.groups.get(a.union)!);
  const generations = [...pools].sort(([a], [b]) => a - b);
  // Share the fixed budget across source generations before taking another
  // arrival from the same generation. Ranking uses the existing route score.
  for (let index = 0; index < FAMILY_ROUTE_REPAIR_LIMITS.perGeneration; index++)
    for (const [level, pool] of generations) {
      const branch = pool[index];
      if (!branch) continue;
      if (attempts >= limit) return { geometry: best, attempts, byGeneration };
      attempts++;
      byGeneration.set(level, (byGeneration.get(level) || 0) + 1);
      const preserved = new Set((best.branches || []).filter((b) => b.id !== branch.id).map((b) => b.id));
      const candidate = routeFamilyMove({ geometry: best, moved: new Set([branch.target]), distance: 0 }, size, preserved);
      const next = score(candidate);
      if (!familyRowNoWorse(next, current) || !familyRowNoWorse(next, initial) || next.crossings >= current.crossings)
        continue;
      best = candidate;
      current = next;
    }
  return { geometry: best, attempts, byGeneration };
}
