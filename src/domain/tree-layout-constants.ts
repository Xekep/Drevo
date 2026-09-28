import type { TreeCardVariant } from "./tree-preferences.ts";

/** Shared geometry constants kept outside layout implementations to avoid runtime cycles. */
export const TREE_NODE_WIDTH = 220;
export const TREE_NODE_HEIGHT = 84;

export type TreeNodeSize = { width: number; height: number };
export function treeNodeSize(
  variant: TreeCardVariant = "classic",
): TreeNodeSize {
  return {
    width: TREE_NODE_WIDTH,
    height: variant === "portrait" ? 264 : TREE_NODE_HEIGHT,
  };
}
