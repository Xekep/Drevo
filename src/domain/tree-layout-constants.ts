/** Shared geometry constants kept outside layout implementations to avoid runtime cycles. */
export const TREE_NODE_WIDTH = 220;
export const TREE_NODE_HEIGHT = 84;
export const FAMILY_ROW_GAP = 64;
/** Preferred breathing room, applied only when primary routing remains safe. */
export const FAMILY_DISPLAY_GAP = 88;
/** Upper bound for an extra ELK pass using previous positions after an edit. */
export const MAX_INCREMENTAL_LAYOUT_PEOPLE = 200;

export type TreeNodeSize = { width: number; height: number };
export function treeNodeSize(): TreeNodeSize {
  return {
    width: TREE_NODE_WIDTH,
    height: 264,
  };
}
