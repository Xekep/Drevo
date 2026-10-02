import type { ElkNode } from "elkjs";

/** Supply the existing genealogy ranks without ELK's dense partition edges. */
export function presetGenerationLayers(graph: ElkNode): ElkNode {
  if (
    graph.layoutOptions?.["elk.direction"] !== "DOWN" ||
    !graph.children?.length ||
    graph.ports?.length
  )
    return graph;
  const ranks = new Map<string, number>();
  const heights = new Map<number, number>();
  const owners = new Map<string, string>();
  for (const node of graph.children) {
    const value = node.layoutOptions?.["elk.partitioning.partition"];
    const rank =
      typeof value !== "string" || value.trim() === "" ? NaN : Number(value);
    if (
      !Number.isSafeInteger(rank) ||
      rank < 0 ||
      !Number.isFinite(node.height) ||
      node.height! <= 0 ||
      !Number.isFinite(node.x ?? 0) ||
      node.children?.length ||
      owners.has(node.id)
    )
      return graph;
    owners.set(node.id, node.id);
    ranks.set(node.id, rank);
    heights.set(rank, Math.max(heights.get(rank) || 0, node.height!));
    for (const port of node.ports || []) {
      if (owners.has(port.id)) return graph;
      owners.set(port.id, node.id);
    }
  }
  // Resolve real nodes and their fixed ports before accepting the preset.
  // An inconsistent edge must keep the original solver rather than silently
  // shifting a descendant away from its prescribed generation.
  for (const edge of graph.edges || []) {
    if (!edge.sources?.length || !edge.targets?.length) return graph;
    let sourceRank = -Infinity,
      targetRank = Infinity;
    for (const source of edge.sources) {
      const rank = ranks.get(owners.get(source) || "");
      if (rank === undefined) return graph;
      sourceRank = Math.max(sourceRank, rank);
    }
    for (const target of edge.targets) {
      const rank = ranks.get(owners.get(target) || "");
      if (rank === undefined) return graph;
      targetRank = Math.min(targetRank, rank);
    }
    if (sourceRank >= targetRank) return graph;
  }
  const tops = new Map<number, number>();
  let top = 0;
  for (const rank of [...heights.keys()].sort((a, b) => a - b)) {
    tops.set(rank, top);
    top += heights.get(rank)! + 36;
    if (!Number.isFinite(top)) return graph;
  }
  return {
    ...graph,
    children: graph.children.map((node) => ({
      ...node,
      x: node.x ?? 0,
      y: tops.get(ranks.get(node.id)!)!,
      layoutOptions: { ...node.layoutOptions },
    })),
    layoutOptions: {
      ...graph.layoutOptions,
      "elk.partitioning.activate": "false",
      "elk.layered.layering.strategy": "INTERACTIVE",
    },
  };
}
