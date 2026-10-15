import type { ElkNode } from "elkjs";
import type { TreeGeometry } from "./tree-layout.ts";

function unionSketchHints(
  graph: ElkNode,
  previous: Pick<TreeGeometry, "positions" | "occurrences">,
  reverse: boolean,
  members?: ReadonlyMap<string, readonly string[]>,
  placement: "balanced" | "interactive" = "balanced",
) {
  const maxY = reverse
    ? Math.max(0, ...previous.positions.map(([, point]) => point.y))
    : 0;
  const positions = new Map(
    previous.positions.map(
      ([id, point]) =>
        [id, reverse ? { x: point.x, y: maxY - point.y } : point] as const,
    ),
  );
  const blocks = new Map<string, { x: number; y: number }[]>();
  for (const occurrence of previous.occurrences || []) {
    const point = positions.get(occurrence.id);
    if (!point) continue;
    const list = blocks.get(occurrence.block) || [];
    list.push(point);
    blocks.set(occurrence.block, list);
  }
  const hints = new Map(
    [...blocks].map(
      ([id, points]) =>
        [
          id,
          {
            x: Math.min(...points.map((point) => point.x)),
            y: Math.min(...points.map((point) => point.y)),
          },
        ] as const,
    ),
  );
  const nodes = graph.children || [];
  // A new single-parent family or partner changes the union ID without removing
  // its existing people. Keep their position instead of treating the block as new.
  for (const node of placement === "interactive" ? nodes : []) {
    if (hints.has(node.id)) continue;
    const known = (members?.get(node.id) || [])
      .map((id) => positions.get(id))
      .filter((p) => p !== undefined);
    if (known.length)
      hints.set(node.id, {
        x: Math.min(...known.map((p) => p.x)),
        y: Math.min(...known.map((p) => p.y)),
      });
  }
  const retained = new Set(
    nodes.filter((node) => hints.has(node.id)).map((node) => node.id),
  );
  const matched = nodes.filter((node) => hints.has(node.id)).length;
  if (matched < 3 || matched < nodes.length * 0.6) return;
  const byPort = new Map(
    nodes.flatMap((node) =>
      (node.ports || []).map((port) => [port.id, node.id] as const),
    ),
  );
  const portX = new Map(
    nodes.flatMap((node) =>
      (node.ports || []).map((port) => [port.id, port.x || 0] as const),
    ),
  );
  for (let pass = 0; pass < 3; pass++)
    for (const edge of graph.edges || []) {
      const source = byPort.get(edge.sources?.[0] || "");
      const target = byPort.get(edge.targets?.[0] || "");
      if (!source || !target) continue;
      if (hints.has(source) && !hints.has(target)) {
        const point = hints.get(source)!;
        hints.set(
          target,
          placement === "interactive"
            ? {
                x:
                  point.x +
                  (portX.get(edge.sources[0]) || 0) -
                  (portX.get(edge.targets[0]) || 0),
                y: point.y + 180,
              }
            : { x: point.x, y: point.y + 180 },
        );
      } else if (
        placement === "interactive" &&
        !hints.has(source) &&
        hints.has(target)
      ) {
        const point = hints.get(target)!;
        hints.set(source, {
          x:
            point.x +
            (portX.get(edge.targets[0]) || 0) -
            (portX.get(edge.sources[0]) || 0),
          y: point.y - 180,
        });
      }
    }
  nodes.forEach((node, index) => {
    if (!hints.has(node.id)) hints.set(node.id, { x: index * 250, y: 0 });
  });
  // Insert a new ancestor into a free slot in its generation. Centering it over
  // its child can invert the order against an existing parent family and force
  // either a crossing or a complete reshuffle of the old generation.
  const rank = (node: ElkNode) =>
    node.layoutOptions?.["elk.partitioning.partition"];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (graph.edges || []).flatMap((edge) => {
    const from = byPort.get(edge.sources?.[0] || ""),
      to = byPort.get(edge.targets?.[0] || "");
    return from && to
      ? [
          {
            from,
            to,
            start: portX.get(edge.sources[0]) || 0,
            end: portX.get(edge.targets[0]) || 0,
          },
        ]
      : [];
  });
  for (const node of placement === "interactive" &&
  nodes.length - retained.size <= 16
    ? nodes
    : []) {
    if (
      retained.has(node.id) ||
      !node.width ||
      rank(node) === undefined ||
      edges.some((edge) => edge.to === node.id)
    )
      continue;
    const outgoing = edges.filter(
      (edge) => edge.from === node.id && retained.has(edge.to),
    );
    if (!outgoing.length) continue;
    const row = nodes
      .filter((other) => retained.has(other.id) && rank(other) === rank(node))
      .map((other) => ({ x: hints.get(other.id)!.x, width: other.width || 0 }))
      .sort((a, b) => a.x - b.x);
    if (!row.length) continue;
    const desired = hints.get(node.id)!;
    const candidates: number[] = [row[0].x - node.width - 64];
    for (let i = 0; i < row.length; i++) {
      const left = row[i].x + row[i].width + 64;
      const right = row[i + 1] ? row[i + 1].x - node.width - 64 : Infinity;
      if (left <= right)
        candidates.push(Math.max(left, Math.min(desired.x, right)));
    }
    const cost = (x: number) => {
      let crossings = 0;
      for (const edge of outgoing)
        for (const other of edges) {
          if (
            !retained.has(other.from) ||
            !retained.has(other.to) ||
            other.to === edge.to ||
            rank(byId.get(other.from)!) !== rank(node) ||
            rank(byId.get(other.to)!) !== rank(byId.get(edge.to)!)
          )
            continue;
          const from = x + edge.start - hints.get(other.from)!.x - other.start;
          const to =
            hints.get(edge.to)!.x +
            edge.end -
            hints.get(other.to)!.x -
            other.end;
          if (from * to < 0) crossings++;
        }
      return crossings;
    };
    candidates.sort(
      (a, b) =>
        cost(a) - cost(b) || Math.abs(a - desired.x) - Math.abs(b - desired.x),
    );
    hints.set(node.id, { ...desired, x: candidates[0] });
  }
  return hints;
}

/** Передаёт ELK прежние позиции блоков как подсказку для инкрементальной раскладки. */
export function fromSketchUnionGraph(
  graph: ElkNode,
  previous: Pick<TreeGeometry, "positions" | "occurrences">,
  reverse = false,
  members?: ReadonlyMap<string, readonly string[]>,
  placement: "balanced" | "interactive" = "balanced",
): ElkNode | undefined {
  const hints = unionSketchHints(graph, previous, reverse, members, placement);
  if (!hints) return;
  return {
    ...graph,
    children: (graph.children || []).map((node) => {
      const point = hints.get(node.id)!;
      return {
        ...node,
        ...(placement === "interactive" ? { x: point.x, y: point.y } : {}),
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
      ...(placement === "interactive"
        ? { "elk.layered.nodePlacement.strategy": "INTERACTIVE" }
        : {}),
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
  const byPort = new Map(
    nodes.flatMap((node) =>
      (node.ports || []).map((port) => [port.id, node.id] as const),
    ),
  );
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
  const pending = new Map(
    nodes.map((node) => [node.id, predecessors.get(node.id)!.length]),
  );
  const queue = nodes
    .filter((node) => !pending.get(node.id))
    .map((node) => node.id);
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
    const order = new Map(
      ranks.flatMap((level) =>
        layers.get(level)!.map((node, index) => [node.id, index] as const),
      ),
    );
    let crossings = 0;
    for (const level of [rank - 1, rank]) {
      const pair = adjacentLinks.get(level) || [];
      for (let first = 0; first < pair.length; first++)
        for (let second = 0; second < first; second++) {
          const [a, b] = pair[first],
            [c, d] = pair[second];
          if (a === c || b === d) continue;
          if (
            (order.get(a)! - order.get(c)!) * (order.get(b)! - order.get(d)!) <
            0
          )
            crossings++;
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
        let bestIndex = oldIndex,
          bestCost = Infinity;
        for (let index = 0; index <= layer.length; index++) {
          layer.splice(index, 0, node);
          const cost = crossingCost(rank);
          if (
            cost < bestCost ||
            (cost === bestCost &&
              Math.abs(index - oldIndex) < Math.abs(bestIndex - oldIndex))
          ) {
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
      "elk.layered.considerModelOrder.crossingCounterNodeInfluence": force
        ? "1"
        : "0.001",
      ...(force
        ? { "elk.layered.crossingMinimization.forceNodeModelOrder": "true" }
        : {}),
    },
  };
}
