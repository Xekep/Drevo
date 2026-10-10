import type { ElkNode } from "elkjs";
import type { ResearchGraph } from "./research-visual.ts";

/** Layered input for a small directed research graph, without archive mutations. */
export function researchGraphLayoutInput(graph: ResearchGraph): ElkNode {
  const ids = new Set(graph.nodes.map((node) => node.id));
  return {
    id: "research",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": {
        TD: "DOWN",
        TB: "DOWN",
        BT: "UP",
        LR: "RIGHT",
        RL: "LEFT",
      }[graph.direction || "TD"],
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: 140,
      height: 80,
    })),
    edges: graph.edges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge, index) => ({
        id: `edge-${index}`,
        sources: [edge.from],
        targets: [edge.to],
      })),
  };
}
