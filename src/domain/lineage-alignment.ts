import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import {
  FAMILY_DISPLAY_GAP,
  FAMILY_ROW_GAP,
  type TreeNodeSize,
} from "./tree-layout-constants.ts";
import {
  familyAxisQuality,
  lineageChains,
  LINEAGE_LIMITS,
  type LineageChain,
} from "./family-axis.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import { locallyReverseCouples } from "./local-couple-order.ts";
import {
  translateFamilyBlocks,
  routeFamilyMove,
  familyRowNoWorse,
  type FamilyRowScore,
} from "./family-row-moves.ts";
import { bundleFamilyBranches } from "./family-branch-bundling.ts";
import { routeRelationships, simplifyRoute } from "./edge-routing.ts";

type Step = {
  center: number;
  flipped: boolean;
  path: { id: string; center: number; flipped: boolean }[];
  peak: number;
  drift: number;
  movement: number;
  flips: number;
};
const order = (a: Step, b: Step) =>
  a.peak - b.peak ||
  a.drift - b.drift ||
  a.movement - b.movement ||
  a.flips - b.flips;

/** Two orientations per couple let a straight ancestry stay in one narrow column. */
function project(
  geometry: TreeGeometry,
  chain: LineageChain,
  size: TreeNodeSize,
  anchor?: number,
  referenceShift = 0,
) {
  const positions = new Map(geometry.positions),
    rows = placedFamilyRows(geometry, size);
  const moving = new Set(chain.blocks.map((b) => b.id));
  const root = chain.blocks[0],
    rootCenter = anchor ?? root.x + root.width / 2,
    axis = rootCenter + referenceShift;
  const fits = (id: string, x: number) => {
    const block = chain.blocks.find((b) => b.id === id)!;
    const row = rows.find((r) => r.some((b) => b.id === id))!;
    return row.every((other) => {
      if (moving.has(other.id)) return true;
      const existing = Math.max(
        other.x - block.x - block.width,
        block.x - other.x - other.width,
      );
      const gap = Math.min(
        FAMILY_DISPLAY_GAP,
        Math.max(FAMILY_ROW_GAP, existing),
      );
      return (
        x + block.width / 2 + gap <= other.x + 0.001 ||
        x - block.width / 2 >= other.x + other.width + gap - 0.001
      );
    });
  };
  if (!fits(root.id, rootCenter)) return;
  const search = (maximum: number, peakFirst: boolean) => {
    const compare = peakFirst
      ? order
      : (a: Step, b: Step) =>
          a.drift - b.drift || a.movement - b.movement || a.flips - b.flips;
    let states: Step[] = [
      {
        center: rootCenter,
        flipped: false,
        path: [{ id: root.id, center: rootCenter, flipped: false }],
        peak: Math.abs(referenceShift),
        drift: Math.abs(referenceShift),
        movement: Math.abs(rootCenter - root.x - root.width / 2),
        flips: 0,
      },
    ];
    for (let index = 1; index < chain.blocks.length; index++) {
      const parent = chain.blocks[index - 1],
        child = chain.blocks[index],
        edge = chain.edges[index - 1];
      const sourceOffset = edge.route.points[0].x - parent.x - parent.width / 2;
      const targetOffset =
        positions.get(edge.target)!.x +
        size.width / 2 -
        child.x -
        child.width / 2;
      const choices = new Map<string, Step>();
      for (const prior of states)
        for (const flipped of child.members.length === 2
          ? [false, true]
          : [false]) {
          const center =
            prior.center +
            sourceOffset * (prior.flipped ? -1 : 1) -
            targetOffset * (flipped ? -1 : 1);
          if (!fits(child.id, center)) continue;
          const distance = Math.abs(center - axis);
          if (distance > maximum + 0.001) continue;
          const step: Step = {
            center,
            flipped,
            path: [...prior.path, { id: child.id, center, flipped }],
            peak: Math.max(prior.peak, distance),
            drift: prior.drift + distance,
            movement:
              prior.movement + Math.abs(center - child.x - child.width / 2),
            flips: prior.flips + Number(flipped),
          };
          const key = JSON.stringify([Math.round(center * 1000), flipped]);
          const existing = choices.get(key);
          if (!existing || compare(step, existing) < 0) choices.set(key, step);
        }
      if (!choices.size) return;
      states = [...choices.values()]
        .sort(compare)
        .slice(0, LINEAGE_LIMITS.states);
    }
    return states.sort(compare)[0];
  };
  // Once the narrowest band is known, additive costs can be optimized without
  // discarding a path whose earlier peak would be hidden by a later obstacle.
  const band = search(Infinity, true);
  return band && search(band.peak, false);
}

function applyPlan(
  geometry: TreeGeometry,
  plan: Step,
  chain: LineageChain,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
) {
  const blocks = new Map(
    placedFamilyRows(geometry, size).flatMap((r) =>
      r.map((b) => [b.id, b] as const),
    ),
  );
  const edges = new Map((geometry.branches || []).map((b) => [b.id, b]));
  const flips = new Set(plan.path.filter((p) => p.flipped).map((p) => p.id));
  const deltas = new Map(
    plan.path.map((p) => [
      p.id,
      p.center - blocks.get(p.id)!.x - blocks.get(p.id)!.width / 2,
    ]),
  );
  if (!flips.size && [...deltas.values()].every((dx) => Math.abs(dx) < 0.01))
    return;
  const swapped = flips.size
    ? locallyReverseCouples(geometry, people, [], size, flips)
    : geometry;
  if (!swapped) return;
  const move = translateFamilyBlocks(swapped, deltas),
    owner = new Map((geometry.occurrences || []).map((o) => [o.id, o.block]));
  const positions = new Map(move.geometry.positions);
  const internal = new Set(chain.edges.map((e) => e.id));
  for (const o of geometry.occurrences || [])
    if (flips.has(o.block)) move.moved.add(o.id);
  move.geometry.branches = move.geometry.branches?.map((edge) => {
    if (
      !edge.id.startsWith("child:") ||
      (!move.moved.has(edge.source) && !move.moved.has(edge.target))
    )
      return edge;
    const old = edges.get(edge.id)!,
      block = blocks.get(owner.get(edge.source)!)!;
    const dx = deltas.get(block.id) || 0;
    const sourceX = flips.has(block.id)
      ? 2 * (block.x + block.width / 2) - old.route.points[0].x + dx
      : old.route.points[0].x + dx;
    const first = { ...old.route.points[0], x: sourceX },
      last = {
        ...old.route.points.at(-1)!,
        x: positions.get(edge.target)!.x + size.width / 2,
      };
    const y = (first.y + last.y) / 2;
    return {
      ...edge,
      route: {
        ...edge.route,
        points: simplifyRoute([
          first,
          { x: first.x, y },
          { x: last.x, y },
          last,
        ]),
      },
    };
  });
  let candidate = bundleFamilyBranches(routeFamilyMove(move, size, internal));
  if (links.length) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const routingPeople = (candidate.occurrences || []).map((o) => ({
      id: o.id,
      birth: byId.get(o.personId)?.birth || "",
      parents: [],
      spouses: [],
    }));
    const routes = routeRelationships(
      routingPeople,
      links,
      candidate.positions,
      size.width,
      size.height,
      new Set(),
      (candidate.branches || []).map((b) => ({
        group: b.union,
        route: b.route,
      })),
    );
    if (routes.length !== (geometry.routes || []).length) return;
    candidate = { ...candidate, routes };
  }

  return candidate;
}

/** Cold-only, bounded and atomic: failed paths retain the complete original scene. */
export function alignFamilyLineages(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  const chains = lineageChains(original, size).sort(
    (a, b) => b.blocks.length - a.blocks.length,
  );
  let best = original,
    budget = original.positions.length <= 300 ? LINEAGE_LIMITS.routes : 3;
  for (const originalChain of chains) {
    if (budget <= 0) break;
    const blocks = new Map(
      placedFamilyRows(best, size).flatMap((r) =>
        r.map((b) => [b.id, b] as const),
      ),
    );
    const edges = new Map((best.branches || []).map((b) => [b.id, b]));
    const chain = {
      blocks: originalChain.blocks.map((b) => blocks.get(b.id)!),
      edges: originalChain.edges.map((b) => edges.get(b.id)!),
    };
    const centers = chain.blocks.map((b) => b.x + b.width / 2),
      ordered = [...centers].sort((a, b) => a - b);
    const axes = [
      ...new Set([
        centers[0],
        ordered[Math.floor(ordered.length / 2)],
        centers.at(-1)!,
      ]),
    ];
    // The common axis can lie between the two natural orientations of a pair.
    const halfStep = Math.max(
      ...chain.blocks.map((b) => (b.width - size.width) / 4),
    );
    const unique = new Map<string, Step>();
    for (const anchor of axes)
      for (const shift of new Set([0, -halfStep, halfStep])) {
        const plan = project(best, chain, size, anchor, shift);
        if (plan) unique.set(JSON.stringify(plan.path), plan);
      }
    const span = (p: Step) =>
      Math.max(...p.path.map((s) => s.center)) -
      Math.min(...p.path.map((s) => s.center));
    const plans = [...unique.values()].sort(
      (a, b) => span(a) - span(b) || order(a, b),
    );
    const before = score(best),
      axisBefore = familyAxisQuality(best, size),
      oldPositions = new Map(best.positions);
    let selected: TreeGeometry | undefined,
      selectedSpan = Infinity,
      selectedDrift = Infinity,
      selectedLength = Infinity;
    for (const plan of plans) {
      if (budget <= 0) break;
      if (
        plan.path.every(
          (p) =>
            !p.flipped &&
            Math.abs(
              p.center - blocks.get(p.id)!.x - blocks.get(p.id)!.width / 2,
            ) < 0.01,
        )
      )
        continue;
      budget--;
      const candidate = applyPlan(best, plan, chain, people, links, size);
      if (!candidate) continue;
      const after = score(candidate),
        axisAfter = familyAxisQuality(candidate, size);
      if (
        !familyRowNoWorse(after, before) ||
        after.length > before.length * 1.02 ||
        after.bends > before.bends + 2 ||
        axisAfter.lineageDrift >= axisBefore.lineageDrift - size.width / 20 ||
        axisAfter.lineageSpan > axisBefore.lineageSpan + 0.01 ||
        axisAfter.interleavings > axisBefore.interleavings ||
        axisAfter.offset > axisBefore.offset + 0.01 ||
        axisAfter.single > axisBefore.single + 0.01 ||
        axisAfter.maxOffset > axisBefore.maxOffset + 0.01
      )
        continue;
      if (
        candidate.positions.some(([id, p]) => p.y !== oldPositions.get(id)?.y)
      )
        continue;
      if (
        axisAfter.lineageSpan < selectedSpan - 0.01 ||
        (Math.abs(axisAfter.lineageSpan - selectedSpan) <= 0.01 &&
          (axisAfter.lineageDrift < selectedDrift - 0.01 ||
            (Math.abs(axisAfter.lineageDrift - selectedDrift) <= 0.01 &&
              after.length < selectedLength)))
      ) {
        selected = candidate;
        selectedSpan = axisAfter.lineageSpan;
        selectedDrift = axisAfter.lineageDrift;
        selectedLength = after.length;
      }
    }
    if (selected) best = selected;
  }
  return best;
}
