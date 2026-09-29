import type { ElkNode } from "elkjs";
import type { TreeGeometry } from "./tree-layout.ts";

function unionSketchHints(
  graph: ElkNode,
  previous: Pick<TreeGeometry, "positions" | "occurrences">,
  reverse: boolean,
) {
  const maxY = reverse ? Math.max(0, ...previous.positions.map(([, point]) => point.y)) : 0;
  const positions = new Map(previous.positions.map(([id, point]) => [
    id,
    reverse ? { x: point.x, y: maxY - point.y } : point,
  ] as const));
  const blocks = new Map<string, { x: number; y: number }[]>();
  for (const occurrence of previous.occurrences || []) {
    const point = positions.get(occurrence.id);
    if (!point) continue;
    const list = blocks.get(occurrence.block) || [];
    list.push(point);
    blocks.set(occurrence.block, list);
  }
  const hints = new Map([...blocks].map(([id, points]) => [id, {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
  }] as const));
  const nodes = graph.children || [];
  const matched = nodes.filter((node) => hints.has(node.id)).length;
  if (matched < 3 || matched < nodes.length * 0.6) return;
  const byPort = new Map(nodes.flatMap((node) =>
    (node.ports || []).map((port) => [port.id, node.id] as const),
  ));
  for (let pass = 0; pass < 3; pass++)
    for (const edge of graph.edges || []) {
      const source = byPort.get(edge.sources?.[0] || "");
      const target = byPort.get(edge.targets?.[0] || "");
      if (!source || !target || !hints.has(source) || hints.has(target)) continue;
      const point = hints.get(source)!;
      hints.set(target, { x: point.x, y: point.y + 180 });
    }
  nodes.forEach((node, index) => {
    if (!hints.has(node.id)) hints.set(node.id, { x: index * 250, y: 0 });
  });
  return hints;
}

/** Передаёт ELK прежние позиции блоков как подсказку для инкрементальной раскладки. */
export function fromSketchUnionGraph(
  graph: ElkNode,
  previous: Pick<TreeGeometry, "positions" | "occurrences">,
  reverse = false,
): ElkNode | undefined {
  const hints = unionSketchHints(graph, previous, reverse);
  if (!hints) return;
  return {
    ...graph,
    children: (graph.children || []).map((node) => {
      const point = hints.get(node.id)!;
      return {
        ...node,
        layoutOptions: {
          ...node.layoutOptions,
          "elk.position": `(${Math.round(point.x)}, ${Math.round(point.y)})`,
        },
      };
    }),
    layoutOptions: {
      ...graph.layoutOptions,
      "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "elk.layered.layering.strategy": "INTERACTIVE",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.separateConnectedComponents": "false",
    },
  };
}

/** Сортирует целые блоки союзов внутри поколений перед запасным запуском ELK. */
export function siftUnionOrder(graph: ElkNode, force = true): ElkNode {
  const nodes = graph.children || [];
  // Перебор позиций квадратичен по рёбрам: на больших проекциях оставляем
  // обычный детерминированный старт ELK с тем же seed.
  if (nodes.length < 3 || nodes.length > 64 || (graph.edges?.length || 0) > 100)
    return graph;
  const byPort = new Map(nodes.flatMap((node) =>
    (node.ports || []).map((port) => [port.id, node.id] as const),
  ));
  const predecessors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const successors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const links: [string, string][] = [];
  for (const edge of graph.edges || []) {
    const source = byPort.get(edge.sources?.[0] || "");
    const target = byPort.get(edge.targets?.[0] || "");
    if (!source || !target || source === target) continue;
    predecessors.get(target)!.push(source);
    successors.get(source)!.push(target);
    links.push([source, target]);
  }
  const pending = new Map(nodes.map((node) => [node.id, predecessors.get(node.id)!.length]));
  const queue = nodes.filter((node) => !pending.get(node.id)).map((node) => node.id);
  const depth = new Map(queue.map((id) => [id, 0]));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const next of successors.get(id)!) {
      depth.set(next, Math.max(depth.get(next) || 0, depth.get(id)! + 1));
      pending.set(next, pending.get(next)! - 1);
      if (!pending.get(next)) queue.push(next);
    }
  }
  if (queue.length !== nodes.length) return graph;
  const layers = new Map<number, ElkNode[]>();
  for (const node of nodes) {
    const rank = depth.get(node.id)!;
    const layer = layers.get(rank) || [];
    layer.push(node);
    layers.set(rank, layer);
  }
  const ranks = [...layers.keys()].sort((a, b) => a - b);
  if ([...layers.values()].some((layer) => layer.length > 24)) return graph;
  const adjacentLinks = new Map<number, [string, string][]>();
  for (const [source, target] of links) {
    const upper = depth.get(source)!;
    if (depth.get(target) !== upper + 1) continue;
    const pair = adjacentLinks.get(upper) || [];
    pair.push([source, target]);
    adjacentLinks.set(upper, pair);
  }
  const crossingCost = (rank: number) => {
    const order = new Map(ranks.flatMap((level) =>
      layers.get(level)!.map((node, index) => [node.id, index] as const),
    ));
    let crossings = 0;
    for (const level of [rank - 1, rank]) {
      const pair = adjacentLinks.get(level) || [];
      for (let first = 0; first < pair.length; first++)
        for (let second = 0; second < first; second++) {
          const [a, b] = pair[first], [c, d] = pair[second];
          if (a === c || b === d) continue;
          if ((order.get(a)! - order.get(c)!) *
              (order.get(b)! - order.get(d)!) < 0) crossings++;
        }
    }
    return crossings;
  };
  for (let pass = 0; pass < 4; pass++)
    for (const rank of pass % 2 ? [...ranks].reverse() : ranks) {
      const layer = layers.get(rank)!;
      for (const node of [...layer]) {
        const oldIndex = layer.indexOf(node);
        layer.splice(oldIndex, 1);
        let bestIndex = oldIndex, bestCost = Infinity;
        for (let index = 0; index <= layer.length; index++) {
          layer.splice(index, 0, node);
          const cost = crossingCost(rank);
          if (cost < bestCost ||
              (cost === bestCost &&
                Math.abs(index - oldIndex) < Math.abs(bestIndex - oldIndex))) {
            bestCost = cost;
            bestIndex = index;
          }
          layer.splice(index, 1);
        }
        layer.splice(bestIndex, 0, node);
      }
    }
  return {
    ...graph,
    children: ranks.flatMap((rank) => layers.get(rank)!),
    layoutOptions: {
      ...graph.layoutOptions,
      "elk.layered.considerModelOrder.crossingCounterNodeInfluence":
        force ? "1" : "0.001",
      ...(force ? { "elk.layered.crossingMinimization.forceNodeModelOrder": "true" } : {}),
    },
  };
}
