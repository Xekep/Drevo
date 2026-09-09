import type { ElkNode, ElkExtendedEdge } from "elkjs";
import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import { TREE_NODE_WIDTH as W, TREE_NODE_HEIGHT as H } from "./tree-layout.ts";
import { routeRelationships, type EdgeRoute } from "./edge-routing.ts";
import type { FamilyLink } from "./types.ts";

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
type Unit = {
  id: string;
  members: string[];
  children: string[];
  married: boolean;
};
const unionId = (ids: string[]) => `union:${JSON.stringify([...ids].sort())}`;

/** Один союз — одна точная пара. Общий супруг не объединяет разные союзы. */
export function familyUnions(people: LayoutPerson[]) {
  const known = new Set(people.map((p) => p.id));
  const units = new Map<string, Unit>();
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
export async function unionGeometry(
  people: LayoutPerson[],
  layout: (graph: ElkNode) => Promise<ElkNode>,
  reverse = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
): Promise<TreeGeometry> {
  const units = familyUnions(people);
  const byId = new Map(people.map((p) => [p.id, p]));
  const origins = new Map<string, Unit>();
  for (const unit of units)
    for (const child of unit.children) origins.set(child, unit);
  const primary = new Map<string, Unit>();
  for (const unit of units)
    for (const id of unit.members) if (!primary.has(id)) primary.set(id, unit);
  for (const p of [...people].sort((a, b) => a.id.localeCompare(b.id))) {
    if (primary.has(p.id)) continue;
    const unit = {
      id: `person:${JSON.stringify(p.id)}`,
      members: [p.id],
      children: [],
      married: false,
    };
    units.push(unit);
    primary.set(p.id, unit);
  }
  type Attachment = { from: Unit; to: Unit; child: string };
  const attachments: Attachment[] = [];
  for (const [child, from] of origins)
    attachments.push({ from, to: primary.get(child)!, child });

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
      children: [],
      married: false,
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
  const depth = new Map(queue.map((id) => [id, 0]));
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
      children: [],
      married: false,
    };
    units.push(leaf);
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
  const width = (u: Unit) => u.members.length * (W + 32) - 32;
  const portId = (u: Unit, person: string) =>
    JSON.stringify([u.id, person, "in"]);
  const nodes: ElkNode[] = units.map((u) => ({
    id: u.id,
    width: width(u),
    height: H + 24,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: [
      {
        id: `${u.id}:out`,
        x: width(u) / 2,
        y: H + 24,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": "SOUTH" },
      },
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
    sources: [`${a.from.id}:out`],
    targets: [portId(a.to, a.child)],
  }));
  // Усыновление влияет на расположение одиночной карточки, но не на состав союза.
  const adoptions = links.filter(
    (l) =>
      l.type === "adoptive_parent" &&
      !origins.has(l.to) &&
      primary.has(l.from) &&
      primary.has(l.to) &&
      primary.get(l.from) !== primary.get(l.to),
  );
  for (const [i, a] of adoptions.entries())
    elkEdges.push({
      id: `adoption:${i}`,
      sources: [`${primary.get(a.from)!.id}:out`],
      targets: [portId(primary.get(a.to)!, a.to)],
    });
  const graph = await layout({
    id: "family-layout",
    children: nodes,
    edges: elkEdges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": "64",
      "elk.spacing.componentComponent": "100",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.thoroughness": "12",
      "elk.separateConnectedComponents": "true",
    },
  });
  const placed = new Map(
    graph.children!.map((n) => [n.id, { x: n.x!, y: n.y! }]),
  );
  const positions: TreeGeometry["positions"] = [];
  const blocks: UnionBlock[] = [];
  for (const unit of units) {
    const p = placed.get(unit.id)!;
    unit.members.forEach((id, i) =>
      positions.push([nodeId(unit, id), { x: p.x + i * (W + 32), y: p.y }]),
    );
    if (unit.members.length > 1)
      blocks.push({
        id: unit.id,
        members: unit.members.map((id) => nodeId(unit, id)),
        ...p,
        width: width(unit),
        height: H,
      });
  }
  const branches: UnionBranch[] = [];
  for (const unit of units) {
    if (unit.members.length !== 2) continue;
    const p = placed.get(unit.id)!;
    const [a, b] = unit.members;
    const relations: UnionBranch["relations"] = unit.married
      ? [{ from: a, to: b, type: "spouse" }]
      : unit.children.flatMap((to) =>
          unit.members.map((from) => ({ from, to, type: "parent" as const })),
        );
    branches.push({
      id: `pair:${unit.id}`,
      source: nodeId(unit, a),
      target: nodeId(unit, b),
      union: unit.id,
      relations,
      route: {
        sourceHandle: "right",
        targetHandle: "left",
        points: [
          { x: p.x + W, y: p.y + H / 2 },
          { x: p.x + W + 32, y: p.y + H / 2 },
        ],
      },
    });
  }
  const laidEdges = new Map(graph.edges!.map((e) => [e.id, e]));
  for (const [i, a] of attachments.entries()) {
    const route = laidEdges.get(`branch:${i}`)!.sections![0];
    const p = placed.get(a.from.id)!;
    const joint = {
      x: p.x + width(a.from) / 2,
      y: p.y + (a.from.members.length > 1 ? H / 2 : H),
    };
    branches.push({
      id: `child:${JSON.stringify(a.child)}`,
      source: nodeId(a.from, a.from.members[0]),
      target: nodeId(a.to, a.child),
      union: a.from.id,
      relations: a.from.members.map((from) => ({
        from,
        to: a.child,
        type: "parent",
      })),
      route: {
        sourceHandle: "bottom",
        targetHandle: "top",
        points: [
          joint,
          route.startPoint,
          ...(route.bendPoints || []),
          route.endPoint,
        ],
      },
    });
  }
  if (reverse) {
    const maxY = Math.max(0, ...positions.map(([, p]) => p.y));
    for (const [, p] of positions) p.y = maxY - p.y;
    for (const b of blocks) b.y = maxY - b.y;
    for (const b of branches) {
      for (const p of b.route.points) p.y = maxY + H - p.y;
      if (b.route.sourceHandle === "bottom") b.route.sourceHandle = "top";
      if (b.route.targetHandle === "top") b.route.targetHandle = "bottom";
    }
  }
  // Дополнительные отношения обходят все отображаемые карточки, включая повторы.
  const extraPeople = occurrences.map((o) => ({
    id: o.id,
    birth: byId.get(o.personId)!.birth,
    parents: [],
    spouses: [],
  }));
  const routes = routeRelationships(extraPeople, links, positions, W, H);
  return {
    mode: "generations",
    reverse,
    start: 1700,
    offset: 0,
    positions,
    routes,
    occurrences,
    blocks,
    branches,
  };
}
