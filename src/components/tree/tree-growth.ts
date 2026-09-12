import type { CSSProperties } from "react";

export const TREE_GROWTH_LEVEL_MS = 650;
export const TREE_GROWTH_EDGE_MS = 330;
export const TREE_GROWTH_NODE_MS = 520;
export const TREE_GROWTH_MAX_LEVEL = 6;

type GrowthStyle = CSSProperties & { "--tree-growth-delay": string };

function cappedGrowthLevel(level: number) {
  return Math.min(TREE_GROWTH_MAX_LEVEL, Math.max(0, level));
}

export function treeNodeGrowthDelay(level: number) {
  return cappedGrowthLevel(level) * TREE_GROWTH_LEVEL_MS;
}

export function treeEdgeGrowthDelay(level: number) {
  return Math.max(0, treeNodeGrowthDelay(level) - TREE_GROWTH_EDGE_MS);
}

export function treeNodeGrowthStyle(level: number): GrowthStyle {
  return { "--tree-growth-delay": `${treeNodeGrowthDelay(level)}ms` };
}

export function treeEdgeGrowthStyle(level: number): GrowthStyle {
  return { "--tree-growth-delay": `${treeEdgeGrowthDelay(level)}ms` };
}

export function treeGrowthDuration(maxLevel: number) {
  return treeNodeGrowthDelay(maxLevel) + TREE_GROWTH_NODE_MS + 100;
}
