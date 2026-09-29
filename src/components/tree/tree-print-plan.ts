import { getNodesBounds } from "@xyflow/react";
import type { ExportTree } from "./tree-pdf";

export type TreePrintOptions = {
  paper: "large" | "a4" | "a3";
  orientation: "landscape" | "portrait";
  marginMm: number;
  scale: number;
};

export const DEFAULT_TREE_PRINT: TreePrintOptions = {
  paper: "large",
  orientation: "landscape",
  marginMm: 10,
  scale: 1,
};

export function treeGraphicBounds(tree: ExportTree) {
  if (!tree.nodes.length) throw new Error("В древе пока нет людей.");
  const bounds = getNodesBounds(tree.nodes);
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  for (const edge of tree.edges)
    for (const point of edge.data?.route?.points || []) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  const padding = 96;
  const contentWidth = right - left;
  const contentHeight = bottom - top;
  const height = Math.max(794, Math.ceil(contentHeight + 2 * padding));
  const width = Math.max(
    1123,
    Math.ceil(contentWidth + 2 * padding),
    Math.ceil(height * Math.SQRT2),
  );
  return {
    width,
    height,
    x: (width - contentWidth) / 2 - left,
    y: (height - contentHeight) / 2 - top,
  };
}

export function treePrintPlan(
  width: number,
  height: number,
  options: TreePrintOptions,
) {
  if (options.paper === "large")
    return {
      widthPt: width * 0.75,
      heightPt: height * 0.75,
      marginPt: 0,
      scale: 1,
      columns: 1,
      rows: 1,
    };
  const millimeters = options.paper === "a3" ? [297, 420] : [210, 297];
  const [short, long] = millimeters.map((value) => (value * 72) / 25.4);
  const widthPt = options.orientation === "landscape" ? long : short;
  const heightPt = options.orientation === "landscape" ? short : long;
  const marginPt = (Math.max(0, Math.min(30, options.marginMm)) * 72) / 25.4;
  const scale = Math.max(0.5, Math.min(2, options.scale));
  const usableWidth = widthPt - 2 * marginPt;
  const usableHeight = heightPt - 2 * marginPt;
  const columns = Math.ceil((width * 0.75 * scale) / usableWidth);
  const rows = Math.ceil((height * 0.75 * scale) / usableHeight);
  if (columns * rows > 36)
    throw new Error(
      `Для печати требуется ${columns * rows} листов. Выберите больший лист или меньшую область древа.`,
    );
  return { widthPt, heightPt, marginPt, scale, columns, rows };
}
