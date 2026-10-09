import type { ElkNode, ElkExtendedEdge } from "elkjs";
import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import {
  TREE_NODE_WIDTH,
  TREE_NODE_HEIGHT,
  MAX_INCREMENTAL_LAYOUT_PEOPLE,
  type TreeNodeSize,
} from "./tree-layout-constants.ts";
import {
  bounds,
  routeRelationships,
  segmentContact,
  segmentHitsBox,
  Spatial,
  type Box,
  type EdgeRoute,
} from "./edge-routing.ts";
import type { FamilyLink } from "./types.ts";
import { optimizeBranches } from "./branch-routing.ts";
import { fromSketchUnionGraph, siftUnionOrder } from "./union-order.ts";
import { presetGenerationLayers } from "./union-layers.ts";
import { routingContactScore } from "./routing-quality.ts";
import {
  coupleBlocksWithContactedAncestry,
  familyPairBlocks,
  invertedCoupleBlocks,
  locallyReverseCouples,
} from "./local-couple-order.ts";
import {
  adjacentFamilyBlocks,
  familyBlockContactScores,
  locallySwapFamilyBlocks,
} from "./local-family-order.ts";
import { householdLevels } from "./household-levels.ts";
import {
  alignGenerationBands,
  GENERATION_DEVIATION,
} from "./generation-bands.ts";
import {
  groupFamilyUnions,
  localUnionRoutes,
  type FamilyUnion,
  type UnionGroup,
} from "./union-groups.ts";

export type UnionOccurrence = { id: string; personId: string; block: string };
export type UnionBranch = {
  id: string;
  source: string;
  target: string;
  relations: { from: string; to: string; type: "parent" | "spouse" }[];
  route: EdgeRoute;
  union: string;
};
export type UnionBlock = {
  id: string;
  members: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};
type Unit = UnionGroup;
type LargeDecrossProfile = "greedy" | "sweep";
const unionId = (ids: string[]) => `union:${JSON.stringify([...ids].sort())}`;

/** Один союз — одна точная пара. Общий супруг не объединяет разные союзы. */
export function familyUnions(people: LayoutPerson[]) {
  const known = new Set(people.map((p) => p.id));
  const units = new Map<string, FamilyUnion>();
  const ensure = (members: string[]) => {
    const ids = [...new Set(members.filter((id) => known.has(id)))].sort();
    if (!ids.length) return undefined;
    const id = unionId(ids);
    if (!units.has(id))
      units.set(id, { id, members: ids, children: [], married: false });
    return units.get(id)!;
  };
  for (const p of people) {
    const origin = ensure(p.parents);
    if (origin) origin.children.push(p.id);
    for (const spouse of p.spouses) {
      if (spouse === p.id || !known.has(spouse)) continue;
      ensure([p.id, spouse])!.married = true;
    }
  }
  return [...units.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Генерационная проекция с визуальными повторами, не копиями записей в архиве. */
async function geometryForSeed(
  people: LayoutPerson[],
  layout: (graph: ElkNode) => Promise<ElkNode>,
  reverse: boolean,
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  seed: number,
  size: TreeNodeSize,
  sift = false,
  sketch?: Pick<TreeGeometry, "positions" | "occurrences">,
  flippedPairs?: ReadonlySet<string>,
  profile?: LargeDecrossProfile,
): Promise<TreeGeometry> {
  if (!people.length)
    return {
      nodeSize: size,
      mode: "generations",
      reverse,
      positions: [],
      start: 1700,
      offset: 0,
      routes: [],
      occurrences: [],
      blocks: [],
      siblingGroups: [],
      generationBands: [],
      branches: [],
    };
  const { width: W, height: H } = size;
  const families = familyUnions(people);
  const byId = new Map(people.map((p) => [p.id, p]));
  const origins = new Map<string, FamilyUnion>();
  for (const family of families)
    for (const child of family.children) origins.set(child, family);
  const adoptedBy = new Map<string, string[]>();
  for (const link of links)
    if (
      (link.type === "adoptive_parent" || link.type === "foster_parent") &&
      !origins.has(link.to)
    ) {
      const parents = adoptedBy.get(link.to) || [];
      parents.push(link.from);
      adoptedBy.set(link.to, parents);
    }
  const levels = householdLevels(
    people.map((p) => ({ ...p, parents: adoptedBy.get(p.id) || p.parents })),
  );
  const units = groupFamilyUnions(families, levels);
  for (const unit of units)
    if (unit.members.length === 2 && flippedPairs?.has(unit.id))
      unit.members.reverse();
  const familyGroups = new Map(
    units.flatMap((u) => u.families.map((f) => [f.id, u] as const)),
  );
  const primary = new Map<string, Unit>();
  for (const unit of units)
    for (const id of unit.members) if (!primary.has(id)) primary.set(id, unit);
  for (const p of [...people].sort((a, b) => a.id.localeCompare(b.id))) {
    if (primary.has(p.id)) continue;
    const unit = {
      id: `person:${JSON.stringify(p.id)}`,
      members: [p.id],
      families: [],
    };
    units.push(unit);
    primary.set(p.id, unit);
  }
  type Attachment = {
    from: Unit;
    to: Unit;
    child: string;
    family: FamilyUnion;
  };
  const attachments: Attachment[] = [];
  for (const [child, family] of origins)
    attachments.push({
      from: familyGroups.get(family.id)!,
      to: primary.get(child)!,
      child,
      family,
    });

  // Циклы возникают в проекции союзов даже при корректном DAG происхождения.
  // Разрываем только визуальную зависимость: ребёнок получает карточку-ссылку.
  const outgoing = new Map(units.map((u) => [u.id, [] as Attachment[]]));
  for (const edge of attachments) outgoing.get(edge.from.id)!.push(edge);
  const color = new Map<string, number>();
  const cuts = new Set<Attachment>();
  for (const root of units) {
    if (color.has(root.id)) continue;
    const stack = [{ id: root.id, index: 0 }];
    color.set(root.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edge = outgoing.get(frame.id)![frame.index++];
      if (!edge) {
        color.set(frame.id, 2);
        stack.pop();
        continue;
      }
      if (color.get(edge.to.id) === 1) cuts.add(edge);
      else if (!color.has(edge.to.id)) {
        color.set(edge.to.id, 1);
        stack.push({ id: edge.to.id, index: 0 });
      }
    }
  }
  for (const edge of cuts) {
    const leaf = {
      id: `reference:${JSON.stringify([edge.from.id, edge.child])}`,
      members: [edge.child],
      families: [],
    };
    units.push(leaf);
    edge.to = leaf;
  }
  // ELK использует рекурсивные стадии. Очень глубокие цепочки показываем
  // частями с теми же карточками-ссылками, сохраняя каждую родительскую связь.
  const incoming = new Map(units.map((u) => [u.id, 0]));
  const children = new Map(units.map((u) => [u.id, [] as Attachment[]]));
  for (const a of attachments) {
    incoming.set(a.to.id, incoming.get(a.to.id)! + 1);
    children.get(a.from.id)!.push(a);
  }
  const queue = units.filter((u) => !incoming.get(u.id)).map((u) => u.id);
  const depth = new Map(
    units.map((u) => [
      u.id,
      Math.max(...u.members.map((id) => levels.get(id) || 0)),
    ]),
  );
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const a of children.get(id)!) {
      depth.set(a.to.id, Math.max(depth.get(a.to.id) || 0, depth.get(id)! + 1));
      incoming.set(a.to.id, incoming.get(a.to.id)! - 1);
      if (!incoming.get(a.to.id)) queue.push(a.to.id);
    }
  }
  for (const a of attachments) {
    if (
      Math.floor(depth.get(a.from.id)! / 100) ===
        Math.floor(depth.get(a.to.id)! / 100) ||
      cuts.has(a)
    )
      continue;
    const leaf = {
      id: `continuation:${JSON.stringify([a.from.id, a.child])}`,
      members: [a.child],
      families: [],
    };
    units.push(leaf);
    depth.set(leaf.id, depth.get(a.to.id)!);
    a.to = leaf;
  }
  const occurrences: UnionOccurrence[] = [];
  const used = new Set(people.map((p) => p.id));
  const occurrence = new Map<string, string>();
  for (const unit of units)
    for (const id of unit.members) {
      let nodeId = id;
      if (primary.get(id) !== unit) {
        nodeId = `occurrence:${JSON.stringify([unit.id, id])}`;
        while (used.has(nodeId)) nodeId += ":";
        used.add(nodeId);
      }
      occurrences.push({ id: nodeId, personId: id, block: unit.id });
      occurrence.set(JSON.stringify([unit.id, id]), nodeId);
    }
  const nodeId = (unit: Unit, person: string) =>
    occurrence.get(JSON.stringify([unit.id, person]))!;
  const unitOccurrences = new Map(
    units.map((u) => [u.id, u.members.map((id) => nodeId(u, id))]),
  );
  const width = (u: Unit) => u.members.length * (W + 32) - 32;
  const localRoutes = new Map(
    units.map((u) => [u.id, localUnionRoutes(u, size)]),
  );
  const familyRoutes = new Map(
    [...localRoutes.values()].flatMap((r) =>
      r.families.map((f) => [f.family.id, f] as const),
    ),
  );
  const layerHeights = new Map<number, number>();
  for (const unit of units) {
    const level = depth.get(unit.id)!;
    layerHeights.set(
      level,
      Math.max(
        layerHeights.get(level) || 0,
        H + 2 * GENERATION_DEVIATION + localRoutes.get(unit.id)!.bottom,
      ),
    );
  }
  const outPort = (family: FamilyUnion) => JSON.stringify([family.id, "out"]);
  const portId = (u: Unit, person: string) =>
    JSON.stringify([u.id, person, "in"]);
  const nodes: ElkNode[] = [...units]
    .sort(
      (a, b) =>
        (byId.get(a.members[0])!.birth || "9999").localeCompare(
          byId.get(b.members[0])!.birth || "9999",
        ) || a.id.localeCompare(b.id),
    )
    .map((u) => ({
      id: u.id,
      width: width(u),
      height: layerHeights.get(depth.get(u.id)!),
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.partitioning.partition": String(depth.get(u.id)),
      },
      ports: [
        {
          id: `${u.id}:adoption`,
          x: width(u) / 2,
          y: layerHeights.get(depth.get(u.id)!),
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": "SOUTH" },
        },
        ...localRoutes.get(u.id)!.families.map((f) => ({
          id: outPort(f.family),
          x: f.joint.x,
          y: layerHeights.get(depth.get(u.id)!),
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": "SOUTH" },
        })),
        ...u.members.map((id, i) => ({
          id: portId(u, id),
          x: i * (W + 32) + W / 2,
          y: 0,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": "NORTH" },
        })),
      ],
    }));
  const elkEdges: ElkExtendedEdge[] = attachments.map((a, i) => ({
    id: `branch:${i}`,
    sources: [outPort(a.family)],
    targets: [portId(a.to, a.child)],
  }));
  // Усыновление влияет на расположение одиночной карточки, но не на состав союза.
  const adoptions = links.filter(
    (l) =>
      (l.type === "adoptive_parent" || l.type === "foster_parent") &&
      !origins.has(l.to) &&
      primary.has(l.from) &&
      primary.has(l.to) &&
      depth.get(primary.get(l.from)!.id)! < depth.get(primary.get(l.to)!.id)!,
  );
  for (const [i, a] of adoptions.entries())
    elkEdges.push({
      id: `adoption:${i}`,
      sources: [`${primary.get(a.from)!.id}:adoption`],
      targets: [portId(primary.get(a.to)!, a.to)],
    });
  const baseGraph: ElkNode = {
    id: "family-layout",
    children: nodes,
    edges: elkEdges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": String(seed),
      "elk.spacing.nodeNode": "64",
      "elk.spacing.componentComponent": "100",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "36",
      "elk.layered.spacing.edgeNodeBetweenLayers": "12",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.thoroughness": people.length > 900 ? "1" : "12",
      "elk.separateConnectedComponents": "true",
      ...(profile
        ? {
            "elk.layered.considerModelOrder.strategy": "NONE",
            "elk.layered.thoroughness": profile === "greedy" ? "1" : "12",
            "elk.layered.crossingMinimization.greedySwitch.activationThreshold":
              profile === "greedy" ? "0" : "40",
            "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
          }
        : {}),
    },
  };
  const hinted = sketch && fromSketchUnionGraph(baseGraph, sketch, reverse);
  if (sketch && !hinted) throw new Error("insufficient prior layout overlap");
  const ordered = hinted || (sift ? siftUnionOrder(baseGraph) : baseGraph);
  // Поколения уже вычислены выше. На больших проекциях передаём их напрямую:
  // partitioning создаёт полный двудольный граф между соседними поколениями.
  // Порядок блоков, минимизация пересечений и фиксированные порты остаются ELK.
  const input = people.length > 300 ? presetGenerationLayers(ordered) : ordered;
  const laidOut = await layout(structuredClone(input));
  const { graph, bands, offsets } = alignGenerationBands(laidOut, size);
  const placed = new Map(
    graph.children!.map((n) => [
      n.id,
      { x: n.x!, y: n.y! + GENERATION_DEVIATION + offsets.get(n.id)! },
    ]),
  );
  const positions: TreeGeometry["positions"] = [];
  const blocks: UnionBlock[] = [];
  const partners = new Map<string, Set<string>>();
  for (const f of families.filter((f) => f.married))
    for (const id of f.members) {
      const list = partners.get(id) || new Set<string>();
      f.members
        .filter((other) => other !== id)
        .forEach((other) => list.add(other));
      partners.set(id, list);
    }
  for (const unit of units) {
    const p = placed.get(unit.id)!;
    unit.members.forEach((id, i) =>
      positions.push([nodeId(unit, id), { x: p.x + i * (W + 32), y: p.y }]),
    );
    // Общая подложка обозначает брак, а не только общих детей.
    if (
      unit.members.length === 2 &&
      unit.families.some((f) => f.married) &&
      unit.members.every((id) => partners.get(id)!.size === 1)
    )
      blocks.push({
        id: unit.id,
        members: unit.members.map((id) => nodeId(unit, id)),
        ...p,
        width: width(unit),
        height: H,
      });
  }
  let branches: UnionBranch[] = [];
  for (const family of families) {
    const unit = familyGroups.get(family.id)!;
    const local = familyRoutes.get(family.id)!;
    if (!local.pair) continue;
    const p = placed.get(unit.id)!;
    const [a, b] = family.members;
    const relations: UnionBranch["relations"] = family.married
      ? [{ from: a, to: b, type: "spouse" }]
      : family.children.flatMap((to) =>
          family.members.map((from) => ({ from, to, type: "parent" as const })),
        );
    branches.push({
      id: `pair:${family.id}`,
      source: nodeId(unit, a),
      target: nodeId(unit, b),
      union: family.id,
      relations,
      route: {
        ...local.pair,
        points: local.pair.points.map((point) => ({
          x: p.x + point.x,
          y: p.y + point.y,
        })),
      },
    });
  }
  const laidEdges = new Map(graph.edges!.map((e) => [e.id, e]));
  for (const [i, a] of attachments.entries()) {
    const route = laidEdges.get(`branch:${i}`)?.sections?.[0];
    const p = placed.get(a.from.id)!;
    const localJoint = familyRoutes.get(a.family.id)!.joint;
    const joint = { x: p.x + localJoint.x, y: p.y + localJoint.y };
    const target = placed.get(a.to.id)!;
    const points = [
      joint,
      route!.startPoint,
      ...(route!.bendPoints || []),
      route!.endPoint,
      { x: route!.endPoint.x, y: target.y },
    ];
    branches.push({
      id: `child:${JSON.stringify(a.child)}`,
      source: nodeId(a.from, a.family.members[0]),
      target: nodeId(a.to, a.child),
      union: a.family.id,
      relations: a.family.members.map((from) => ({
        from,
        to: a.child,
        type: "parent",
      })),
      route: {
        sourceHandle: "bottom",
        targetHandle: "top",
        points,
      },
    });
  }
  branches = optimizeBranches(branches, positions, W, H);
  if (reverse) {
    const maxY = Math.max(0, ...positions.map(([, p]) => p.y));
    for (const [, p] of positions) p.y = maxY - p.y;
    for (const b of blocks) b.y = maxY - b.y;
    for (const band of bands) {
      band.targetY = maxY - band.targetY;
      band.minY = band.targetY - GENERATION_DEVIATION;
      band.maxY = band.targetY + GENERATION_DEVIATION;
    }
    for (const b of branches) {
      for (const p of b.route.points) p.y = maxY + H - p.y;
      const mirror = (handle: EdgeRoute["sourceHandle"]) =>
        handle === "bottom" ? "top" : handle === "top" ? "bottom" : handle;
      b.route.sourceHandle = mirror(b.route.sourceHandle);
      b.route.targetHandle = mirror(b.route.targetHandle);
    }
  }
  // Дополнительные отношения обходят все отображаемые карточки, включая повторы.
  const extraPeople = occurrences.map((o) => ({
    id: o.id,
    birth: byId.get(o.personId)!.birth,
    parents: [],
    spouses: [],
  }));
  const routes = routeRelationships(
    extraPeople,
    links,
    positions,
    W,
    H,
    new Set(),
    branches.map((b) => ({ group: b.union, route: b.route })),
  );
  return {
    nodeSize: size,
    mode: "generations",
    reverse,
    start: 1700,
    offset: 0,
    positions,
    routes,
    occurrences,
    blocks,
    siblingGroups: [],
    generationBands: bands.map((band) => ({
      ...band,
      members: band.members.flatMap((id) => unitOccurrences.get(id)!),
    })),
    branches,
  };
}

export function branchContactCounts(branches: UnionBranch[]) {
  type Point = EdgeRoute["points"][number];
  type Segment = ReturnType<typeof bounds> & {
    a: Point;
    b: Point;
    union: number;
  };
  const lines = new Spatial<Segment>();
  const distinct = new Set<string>();
  const unionIds = new Map<string, number>();
  let segments = 0;
  for (const branch of branches) {
    let union = unionIds.get(branch.union);
    if (union === undefined) {
      union = unionIds.size;
      unionIds.set(branch.union, union);
    }
    for (let i = 1; i < branch.route.points.length; i++) {
      const a = branch.route.points[i - 1],
        b = branch.route.points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const box = bounds(a, b);
      for (const previous of lines.query(box)) {
        if (previous.union === union) continue;
        const contact = segmentContact(a, b, previous.a, previous.b);
        if (!contact) continue;
        segments++;
        const first = Math.min(union, previous.union);
        const second = Math.max(union, previous.union);
        distinct.add(`${first}:${second}:${contact}`);
      }
      lines.add({ ...box, a, b, union });
    }
  }
  return { distinct: distinct.size, segments };
}

function axisDisplacement(
  previous: TreeGeometry,
  current: TreeGeometry,
  axis: "x" | "y",
) {
  const old = new Map(previous.positions);
  const shifts = current.positions
    .filter(([id]) => old.has(id))
    .map(([id, point]) => point[axis] - old.get(id)![axis])
    .sort((a, b) => a - b);
  if (shifts.length < 3 || shifts.length < current.positions.length * 0.6)
    return Infinity;
  const offset = shifts[Math.floor(shifts.length / 2)];
  return (
    shifts.reduce((sum, shift) => sum + Math.abs(shift - offset), 0) /
    shifts.length
  );
}

function routeCardContacts(
  geometry: TreeGeometry,
  width: number,
  height: number,
) {
  const cards = new Spatial<Box>();
  for (const [, point] of geometry.positions)
    cards.add({
      left: point.x,
      right: point.x + width,
      top: point.y,
      bottom: point.y + height,
    });
  let contacts = 0;
  const routes = [
    ...(geometry.branches || []).map((branch) => branch.route),
    ...(geometry.routes || []).map(([, route]) => route),
  ];
  for (const route of routes)
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1],
        b = route.points[index];
      for (const card of cards.query(bounds(a, b)))
        if (segmentHitsBox(a, b, card)) contacts++;
    }
  return contacts;
}

function cardOverlapCount(
  geometry: TreeGeometry,
  width: number,
  height: number,
) {
  const cards = new Spatial<Box>();
  let overlaps = 0;
  for (const [, point] of geometry.positions) {
    const box = {
      left: point.x,
      right: point.x + width,
      top: point.y,
      bottom: point.y + height,
    };
    for (const other of cards.query(box))
      if (
        box.left < other.right &&
        box.right > other.left &&
        box.top < other.bottom &&
        box.bottom > other.top
      )
        overlaps++;
    cards.add(box);
  }
  return overlaps;
}

/** Кэш живёт один расчёт; готовые геометрии кандидатов больше не изменяются. */
export function createGeometryContactScorer(width = TREE_NODE_WIDTH, height = TREE_NODE_HEIGHT) {
  const cardScores = new WeakMap<TreeGeometry, { contacts?: number; overlaps?: number }>();
  const cards = (geometry: TreeGeometry) => {
    let result = cardScores.get(geometry);
    if (!result) { result = {}; cardScores.set(geometry, result); }
    return result;
  };
  const scores = new WeakMap<
    TreeGeometry,
    ReturnType<typeof routingContactScore>
  >();
  const score = (geometry: TreeGeometry) => {
    let result = scores.get(geometry);
    if (!result) {
      result = routingContactScore(
        (geometry.branches || []).map((branch) => ({
          group: branch.union,
          route: branch.route,
        })),
      );
      scores.set(geometry, result);
    }
    return result;
  };
  return {
    cardContacts: (geometry: TreeGeometry) =>
      cards(geometry).contacts ??= routeCardContacts(geometry, width, height),
    cardOverlaps: (geometry: TreeGeometry) =>
      cards(geometry).overlaps ??= cardOverlapCount(geometry, width, height),
    contacts: (geometry: TreeGeometry) => score(geometry).contacts,
    quality: (geometry: TreeGeometry) => score(geometry).quality,
    // Additional relationships do not choose positions of the primary family.
    compare: (a: TreeGeometry, b: TreeGeometry) => {
      const first = score(a),
        second = score(b);
      return (
        first.quality.crossings - second.quality.crossings ||
        first.contacts.distinct - second.contacts.distinct ||
        first.contacts.segments - second.contacts.segments
      );
    },
  };
}

/** Сравниваем видимые маршруты после ELK и уплотнения полос поколений. */
export async function unionGeometry(
  people: LayoutPerson[],
  layout: (graph: ElkNode) => Promise<ElkNode>,
  reverse = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
  size: TreeNodeSize = { width: TREE_NODE_WIDTH, height: TREE_NODE_HEIGHT },
  previous?: TreeGeometry,
  largeDecross = true,
): Promise<TreeGeometry> {
  const { width: W, height: H } = size;
  const {
    contacts: geometryContacts,
    quality: geometryQuality,
    compare,
    cardContacts: routeCardContacts,
    cardOverlaps: cardOverlapCount,
  } = createGeometryContactScorer(W, H);
  const initialProfile =
    people.length > 900 && largeDecross ? "greedy" : undefined;
  let best = await geometryForSeed(
    people,
    layout,
    reverse,
    links,
    1,
    size,
    false,
    undefined,
    undefined,
    initialProfile,
  );
  let bestSeed = 1;
  let contacts = geometryContacts(best);
  let profileQuality = initialProfile && geometryQuality(best);
  let profileCardContacts = initialProfile ? routeCardContacts(best) : 0;
  let profileOverlaps = initialProfile ? cardOverlapCount(best) : 0;
  const seedCandidates =
    previous && people.length <= MAX_INCREMENTAL_LAYOUT_PEOPLE
      ? [{ geometry: best, contacts }]
      : [];

  const extent = (geometry: TreeGeometry) => {
    const xs = geometry.positions.map(([, p]) => p.x),
      ys = geometry.positions.map(([, p]) => p.y);
    return {
      width: Math.max(...xs) - Math.min(...xs) + W,
      height: Math.max(...ys) - Math.min(...ys) + H,
    };
  };
  const initial = extent(best);
  // На больших архивах ограничиваем число запусков ELK, сохраняя
  // детерминированный результат для одного и того же набора людей.
  // On 423-556 person fixtures the third ELK run did not improve quality,
  // while it helped at 782 people. Keep one alternate seed through 2000.
  const seeds = !contacts.distinct
    ? []
    : people.length <= 300
      ? [15, 20, 12, 4, 8]
      : people.length <= 700
        ? [15]
        : people.length <= 900
          ? [15, 20]
          : people.length <= 2000
            ? [15]
            : [];
  const candidates: { seed: number; profile?: LargeDecrossProfile }[] =
    seeds.map((seed) => ({ seed, profile: initialProfile }));
  // На больших графах сравниваем дешёвый greedy и независимые layer sweeps.
  // Ни один профиль не выигрывает на всех семейных структурах.
  if (initialProfile && contacts.distinct)
    candidates.push(
      ...(people.length <= 2000 ? [1, 15] : [1]).map((seed) => ({
        seed,
        profile: "sweep" as const,
      })),
    );
  for (const { seed, profile } of candidates) {
    let candidate: TreeGeometry;
    try {
      candidate = await geometryForSeed(
        people,
        layout,
        reverse,
        links,
        seed,
        size,
        people.length <= 100 && seed === 8,
        undefined,
        undefined,
        profile,
      );
    } catch {
      continue;
    }
    const candidateExtent = extent(candidate);
    if (
      Math.max(candidateExtent.width, candidateExtent.height) >
        Math.max(initial.width, initial.height) * 1.4 ||
      candidateExtent.width * candidateExtent.height >
        initial.width * initial.height * 1.5
    )
      continue;
    const next = geometryContacts(candidate);
    if (seedCandidates.length)
      seedCandidates.push({ geometry: candidate, contacts: next });
    if (next.distinct <= contacts.distinct && compare(candidate, best) < 0) {
      // Preserve readable primary routes and the layout budget. Extra lines may
      // cross each other, but the existing card-hit checks still protect cards.
      if (profileQuality) {
        const quality = geometryQuality(candidate);
        if (
          quality.length > profileQuality.length * 1.15 ||
          quality.bends > profileQuality.bends * 1.15 + 2
        )
          continue;
        const cardContacts = routeCardContacts(candidate);
        const overlaps = cardOverlapCount(candidate);
        if (cardContacts > profileCardContacts || overlaps > profileOverlaps)
          continue;
        profileQuality = quality;
        profileCardContacts = cardContacts;
        profileOverlaps = overlaps;
      }
      best = candidate;
      bestSeed = seed;
      contacts = next;
    }
    if (!contacts.distinct) break;
  }
  if (
    previous?.mode === "generations" &&
    previous.reverse === reverse &&
    (!previous.nodeSize ||
      (previous.nodeSize.width === W && previous.nodeSize.height === H)) &&
    people.length <= MAX_INCREMENTAL_LAYOUT_PEOPLE &&
    previous.positions.length
  ) {
    // Одна устранённая точка контакта не должна переставлять почти всё дерево.
    // Рассматриваем только уже рассчитанные seed-варианты с небольшой разницей качества.
    if (contacts.distinct > 0) {
      const contactDisplacementCost = 3000;
      const minimumContacts = contacts.distinct;
      const oldSize = extent(previous);
      let movement = axisDisplacement(previous, best, "x");
      for (const item of seedCandidates) {
        const delta = item.contacts.distinct - minimumContacts;
        if (delta < 0 || delta > 1 || item.geometry === best) continue;
        const nextMovement = axisDisplacement(previous, item.geometry, "x");
        if (
          !Number.isFinite(nextMovement) ||
          movement - nextMovement < 100 ||
          item.contacts.distinct * contactDisplacementCost + nextMovement >=
            contacts.distinct * contactDisplacementCost + movement ||
          item.contacts.segments > contacts.segments + (delta ? 2 : 0) ||
          axisDisplacement(previous, item.geometry, "y") >
            Math.max(axisDisplacement(previous, best, "y"), 32) + 64
        )
          continue;
        const currentSize = extent(best),
          nextSize = extent(item.geometry);
        const currentRoutes = geometryQuality(best);
        const nextRoutes = geometryQuality(item.geometry);
        if (
          nextRoutes.contacts > currentRoutes.contacts + delta ||
          nextRoutes.crossings > currentRoutes.crossings + delta ||
          nextRoutes.length > currentRoutes.length * 1.15 ||
          routeCardContacts(item.geometry) >
            routeCardContacts(best) ||
          Math.max(nextSize.width, nextSize.height) >
            Math.max(
              oldSize.width,
              oldSize.height,
              currentSize.width,
              currentSize.height,
            ) *
              1.2 ||
          nextSize.width * nextSize.height >
            Math.max(
              oldSize.width * oldSize.height,
              currentSize.width * currentSize.height,
            ) *
              1.5
        )
          continue;
        best = item.geometry;
        contacts = item.contacts;
        movement = nextMovement;
      }
    }
    const movement = axisDisplacement(previous, best, "x");
    if (movement >= 150 && Number.isFinite(movement)) {
      try {
        const candidate = await geometryForSeed(
          people,
          layout,
          reverse,
          links,
          1,
          size,
          false,
          previous,
        );
        const next = geometryContacts(candidate);
        const currentRoutes = geometryQuality(best);
        const nextRoutes = geometryQuality(candidate);
        const oldSize = extent(previous);
        const currentSize = extent(best);
        const nextSize = extent(candidate);
        const nextMovement = axisDisplacement(previous, candidate, "x");
        if (
          next.distinct <= contacts.distinct &&
          nextRoutes.contacts <= currentRoutes.contacts &&
          nextRoutes.crossings <= currentRoutes.crossings &&
          nextRoutes.length <= currentRoutes.length * 1.15 &&
          nextRoutes.bends <= currentRoutes.bends * 1.15 + 2 &&
          routeCardContacts(candidate) <= routeCardContacts(best) &&
          Math.max(nextSize.width, nextSize.height) <=
            Math.max(
              oldSize.width,
              oldSize.height,
              currentSize.width,
              currentSize.height,
            ) *
              1.2 &&
          nextSize.width * nextSize.height <=
            Math.max(
              oldSize.width * oldSize.height,
              currentSize.width * currentSize.height,
            ) *
              1.5 &&
          nextMovement <= movement * 0.7 &&
          movement - nextMovement >= 100 &&
          axisDisplacement(previous, candidate, "y") <=
            Math.max(axisDisplacement(previous, best, "y"), 32) + 32
        ) {
          best = candidate;
          contacts = next;
        }
      } catch {
        // Если инкрементальный ELK не смог построить вариант, остаётся обычная раскладка.
      }
    }
  }
  if (!previous && people.length <= 300 && contacts.distinct) {
    const flipped = invertedCoupleBlocks(best, W);
    if (flipped.size) {
      try {
        const candidate = await geometryForSeed(
          people,
          layout,
          reverse,
          links,
          bestSeed,
          size,
          false,
          undefined,
          flipped,
        );
        const next = geometryContacts(candidate);
        const candidateExtent = extent(candidate);
        const bestExtent = extent(best);
        const currentRoutes = geometryQuality(best);
        const nextRoutes = geometryQuality(candidate);
        if (
          next.distinct < contacts.distinct &&
          nextRoutes.crossings <= currentRoutes.crossings &&
          nextRoutes.length <= currentRoutes.length * 1.15 &&
          Math.max(candidateExtent.width, candidateExtent.height) <=
            Math.max(bestExtent.width, bestExtent.height) * 1.2 &&
          candidateExtent.width * candidateExtent.height <=
            bestExtent.width * bestExtent.height * 1.35 &&
          routeCardContacts(candidate) <= routeCardContacts(best)
        ) {
          best = candidate;
          contacts = next;
        }
      } catch {
        // The original layout remains valid if ELK rejects the alternative order.
      }
    }
  }
  if (people.length <= 1200 && contacts.distinct) {
    // Keep ELK block coordinates; reject each local spouse swap unless its rerouted
    // ancestry improves primary family routes.
    let currentRoutes = geometryQuality(best);
    let cardContacts = routeCardContacts(best);
    let currentPositions = new Map(best.positions);
    const priorPositions = previous && new Map(previous.positions);
    const blocksById = new Map(
      familyPairBlocks(best).map((block) => [block.id, block]),
    );
    const passes =
      previous && people.length <= MAX_INCREMENTAL_LAYOUT_PEOPLE ? 3 : 1;
    for (let pass = 0; pass < passes; pass++) {
      let changed = false;
      for (const id of coupleBlocksWithContactedAncestry(best, W).slice(
        0,
        people.length > 900 ? 50 : undefined,
      )) {
        const members = blocksById.get(id)?.members;
        let unchangedOrientation = false;
        if (
          priorPositions &&
          members?.every((member) => priorPositions.has(member))
        ) {
          const [a, b] = members;
          unchangedOrientation =
            currentPositions.get(a)!.x < currentPositions.get(b)!.x ===
            priorPositions.get(a)!.x < priorPositions.get(b)!.x;
        }
        const candidate = locallyReverseCouples(
          best,
          people,
          links,
          size,
          new Set([id]),
        );
        if (!candidate) continue;
        const next = geometryContacts(candidate);
        if (next.distinct > contacts.distinct) continue;
        const nextRoutes = geometryQuality(candidate);
        // Preserve orientation for incidental touches. Removing a real crossing
        // may justify a pair swap, but keep average displacement tightly bounded.
        if (
          unchangedOrientation &&
          (nextRoutes.crossings >= currentRoutes.crossings ||
            axisDisplacement(previous!, candidate, "x") >
              axisDisplacement(previous!, best, "x") + 32)
        )
          continue;
        if (
          (next.distinct === contacts.distinct &&
            nextRoutes.crossings >= currentRoutes.crossings) ||
          nextRoutes.contacts > currentRoutes.contacts ||
          nextRoutes.crossings > currentRoutes.crossings ||
          nextRoutes.length > currentRoutes.length * 1.02 ||
          nextRoutes.bends > currentRoutes.bends + 2
        )
          continue;
        const nextCardContacts = routeCardContacts(candidate);
        if (nextCardContacts > cardContacts) continue;
        best = candidate;
        contacts = next;
        currentRoutes = nextRoutes;
        cardContacts = nextCardContacts;
        currentPositions = new Map(candidate.positions);
        changed = true;
      }
      if (!changed) break;
    }
  }
  if (
    contacts.distinct &&
    ((!previous && people.length <= 1200) ||
      (previous && people.length <= MAX_INCREMENTAL_LAYOUT_PEOPLE))
  ) {
    // Exchange neighboring union slots within a generation without another ELK pass.
    // Prioritize blocks whose routes already touch foreign family routes.
    const pairKey = ([left, right]: [string, string]) => `${left}\0${right}`;
    let currentRoutes = geometryQuality(best);
    const originalLength = currentRoutes.length;
    const initialMovement = previous && axisDisplacement(previous, best, "x");
    let cardContacts = routeCardContacts(best);
    let cardOverlaps = cardOverlapCount(best);
    // A preceding swap can expose a new neighbor. Revisit at most three times
    // while limiting added mean displacement to one card width.
    for (let pass = 0; pass < (previous ? 3 : 1); pass++) {
      let changed = false;
      const scores = familyBlockContactScores(best);
      const widths = new Map((best.blocks || []).map((block) => [block.id, block.width]));
      const candidates = adjacentFamilyBlocks(best, size)
        .filter(
          ([left, right]) =>
            (scores.get(left) || 0) + (scores.get(right) || 0) > 0 &&
            // Keep small cold layouts stable for later incremental edits.
            // Only the previously unsupported different-width moves are new here.
            (!!previous || people.length > 300 || widths.get(left) !== widths.get(right)),
        )
        .sort(
          ([a, b], [c, d]) =>
            (scores.get(c) || 0) +
            (scores.get(d) || 0) -
            (scores.get(a) || 0) -
            (scores.get(b) || 0),
        )
        .slice(0, previous || people.length > 900 ? 50 : 200);
      let adjacent = new Set(adjacentFamilyBlocks(best, size).map(pairKey));
      for (const [left, right] of candidates) {
        if (!adjacent.has(pairKey([left, right]))) continue;
        const candidate = locallySwapFamilyBlocks(
          best,
          left,
          right,
          people,
          links,
          size,
        );
        if (!candidate) continue;
        const next = geometryContacts(candidate);
        if (next.distinct >= contacts.distinct) continue;
        const nextRoutes = geometryQuality(candidate);
        if (
          previous &&
          axisDisplacement(previous, candidate, "x") > initialMovement! + W
        )
          continue;
        if (
          nextRoutes.contacts > currentRoutes.contacts ||
          nextRoutes.crossings > currentRoutes.crossings ||
          nextRoutes.length > currentRoutes.length * 1.01 ||
          nextRoutes.length > originalLength * 1.01 ||
          nextRoutes.bends > currentRoutes.bends + 4
        )
          continue;
        const nextCardContacts = routeCardContacts(candidate);
        if (nextCardContacts > cardContacts) continue;
        const nextCardOverlaps = cardOverlapCount(candidate);
        if (nextCardOverlaps > cardOverlaps) continue;
        best = candidate;
        contacts = next;
        currentRoutes = nextRoutes;
        cardContacts = nextCardContacts;
        cardOverlaps = nextCardOverlaps;
        adjacent = new Set(adjacentFamilyBlocks(best, size).map(pairKey));
        changed = true;
      }
      if (!changed) break;
    }
  }
  return best;
}
