import type { TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import type { FamilyRowMove } from "./family-row-moves.ts";
import { familyPairBlocks } from "./local-couple-order.ts";
import { simplifyRoute } from "./edge-routing.ts";

/** A partner without drawn ancestry can occupy either side of the anchored
 * partner. Keep the anchored person and the child fixed; no names/sex rules. */
export function freePartnerPlacements(geometry: TreeGeometry, links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize): FamilyRowMove[] {
  if (geometry.mode !== "generations" || geometry.positions.length > 600) return [];
  const positions = new Map(geometry.positions), branches = geometry.branches || [];
  const incoming = new Set(branches.filter(b => b.id.startsWith("child:")).map(b => b.target));
  const personIds = new Map(geometry.occurrences?.map(o => [o.id, o.personId]) || []);
  const proposals: (FamilyRowMove & { gain: number })[] = [];
  for (const block of familyPairBlocks(geometry)) {
    const [a, b] = block.members;
    if (incoming.has(a) === incoming.has(b)) continue;
    const anchor = incoming.has(a) ? a : b, free = anchor === a ? b : a;
    const fixed = positions.get(anchor)!, old = positions.get(free)!;
    if (Math.abs(Math.abs(fixed.x - old.x) - size.width - 32) > 0.01) continue;
    const freePerson = personIds.get(free) || free;
    // Extra routes with a moved endpoint need a separate reroute; retain them.
    if (links.some(link => link.from === freePerson || link.to === freePerson)) continue;
    const pair = branches.find(branch => branch.id.startsWith("pair:") &&
      ((branch.source === a && branch.target === b) || (branch.source === b && branch.target === a)));
    if (!pair || pair.route.points.length !== 2 || pair.route.points[0].y !== pair.route.points[1].y) continue;
    const children = branches.filter(branch => branch.id.startsWith("child:") && branch.union === pair.union);
    if (children.length !== 1) continue;
    const child = children[0], end = child.route.points.at(-1)!;
    const newX = 2 * fixed.x - old.x, jointX = (fixed.x + newX + size.width) / 2;
    const gain = Math.abs(child.route.points[0].x - end.x) - Math.abs(jointX - end.x);
    if (gain < size.width / 10) continue;
    if (proposals.length === 8 && gain <= proposals.at(-1)!.gain) continue;
    const next = new Map(positions); next.set(free, { ...old, x: newX });
    const shiftBlock = (item: NonNullable<TreeGeometry["blocks"]>[number]) => {
      if (!item.members.includes(free)) return item;
      const xs = item.members.map(id => next.get(id)!.x);
      return { ...item, members: [...item.members].sort((a, b) => next.get(a)!.x - next.get(b)!.x),
        x: Math.min(...xs), width: Math.max(...xs) - Math.min(...xs) + size.width };
    };
    proposals.push({ gain, distance: Math.abs(newX - old.x), moved: new Set([anchor, free]), geometry: {
      ...geometry,
      positions: geometry.positions.map(([id, point]) => [id, id === free ? { ...point, x: newX } : point]),
      blocks: geometry.blocks?.map(shiftBlock), siblingGroups: geometry.siblingGroups?.map(shiftBlock),
      branches: branches.map(branch => {
        if (branch === pair) {
          const source = next.get(pair.source)!, target = next.get(pair.target)!, forward = source.x < target.x;
          return { ...branch, route: { sourceHandle: forward ? "right" : "left", targetHandle: forward ? "left" : "right",
            points: [{ x: source.x + (forward ? size.width : 0), y: pair.route.points[0].y },
              { x: target.x + (forward ? 0 : size.width), y: pair.route.points[1].y }] } };
        }
        if (branch !== child) return branch;
        const start = { ...branch.route.points[0], x: jointX }, middle = (start.y + end.y) / 2;
        return { ...branch, route: { ...branch.route,
          points: simplifyRoute([start, { x: jointX, y: middle }, { x: end.x, y: middle }, end]) } };
      }),
    } });
    proposals.sort((a, b) => b.gain - a.gain || a.distance - b.distance);
    if (proposals.length > 8) proposals.pop();
  }
  return proposals;
}
