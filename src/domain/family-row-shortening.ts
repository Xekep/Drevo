import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  reorderFamilyRow,
  routeFamilyMove,
  type FamilyRowMove,
  type FamilyRowScore,
} from "./family-row-moves.ts";
import { bundleFamilyBranches } from "./family-branch-bundling.ts";
import { preferFamilyLayout } from "./family-layout-candidates.ts";
import { routeRelationships } from "./edge-routing.ts";
import { packedSiblingRows } from "./family-sibling-packing.ts";

/** Close long single-child connections by inserting the parent household nearer
 * its child in the same row. Neighbours trade slots; descendants stay fixed.
 * Also regroup interleaved siblings, compacting the changed row segment.
 * Only cold layouts call this bounded pass, including crossing-free scenes. */
export function shortenFamilyRows(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
): TreeGeometry {
  if (original.mode !== "generations" || people.length > 600) return original;
  const primary = original.routes?.length
    ? { ...original, routes: [] }
    : original;
  let best = primary;
  for (let pass = 0; pass < 2; pass++) {
    const before = score(best),
      rows = placedFamilyRows(best, size);
    const owner = new Map((best.occurrences || []).map((o) => [o.id, o.block]));
    const outgoing = new Map<string, NonNullable<TreeGeometry["branches"]>>();
    for (const branch of best.branches || []) {
      const block = owner.get(branch.source);
      if (!block || !branch.id.startsWith("child:")) continue;
      outgoing.set(block, [...(outgoing.get(block) || []), branch]);
    }
    const roots = [...outgoing]
      .filter(([, edges]) => edges.length === 1)
      .map(([block, [edge]]) => ({
        block,
        edge,
        dx: edge.route.points.at(-1)!.x - edge.route.points[0].x,
      }))
      .filter((root) => Math.abs(root.dx) > size.width)
      .sort((a, b) => Math.abs(b.dx) - Math.abs(a.dx))
      .slice(0, 16);
    const candidates: {
      move: FamilyRowMove;
      length: number;
      crossings: number;
      contacts: number;
    }[] = [];
    const retain = (move: FamilyRowMove) => {
      const quality = score(move.geometry);
      if (
        quality.overlaps > before.overlaps ||
        quality.crossings > before.crossings ||
        quality.length >= before.length - size.width / 10
      )
        return;
      candidates.push({
        move,
        length: quality.length,
        crossings: quality.crossings,
        contacts: quality.contacts,
      });
      candidates.sort(
        (a, b) =>
          a.crossings - b.crossings ||
          a.contacts - b.contacts ||
          a.length - b.length ||
          a.move.distance - b.move.distance,
      );
      if (candidates.length > 8) candidates.pop();
    };
    for (const move of packedSiblingRows(best, size)) retain(move);
    for (const root of roots) {
      const row = rows.find((r) => r.some((b) => b.id === root.block));
      if (!row || row.length > 64) continue;
      const from = row.findIndex((b) => b.id === root.block);
      for (let step = 1; step <= 8; step++) {
        const to = from + Math.sign(root.dx) * step;
        if (to < 0 || to >= row.length) break;
        const move = reorderFamilyRow(best, row, from, to);
        if (!move) continue;
        const branch = move.geometry.branches!.find(
          (b) => b.id === root.edge.id,
        )!;
        if (
          Math.abs(branch.route.points.at(-1)!.x - branch.route.points[0].x) >=
          Math.abs(root.dx)
        )
          continue;
        retain(move);
      }
    }
    let selected = best;
    for (const { move } of candidates) {
      const candidate = bundleFamilyBranches(routeFamilyMove(move, size));
      if (
        score(candidate).length < score(selected).length - size.width / 10 &&
        preferFamilyLayout(candidate, selected, size, score) &&
        preferFamilyLayout(candidate, primary, size, score)
      )
        selected = candidate;
    }
    if (selected === best) break;
    best = selected;
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
  return score(result).length < score(original).length &&
    preferFamilyLayout(result, original, size, score)
    ? result
    : original;
}
