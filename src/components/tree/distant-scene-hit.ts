import type { Viewport } from "@xyflow/react";
import type { PersonNodeType } from "./person-node.tsx";
import type { RelationshipEdgeType } from "./relationship-edge.tsx";

/** Uses the same world coordinates as React Flow; only the pointer is in screen pixels. */
export function hitDistantScene(
  nodes: readonly PersonNodeType[],
  edges: readonly RelationshipEdgeType[],
  camera: Viewport,
  point: { x: number; y: number },
): { node: PersonNodeType; edge?: never } | { node?: never; edge: RelationshipEdgeType } | null {
  let nearestNode: PersonNodeType | undefined;
  let nearestNodeDistance = Infinity;
  for (const node of nodes) {
    const x = camera.x + node.position.x * camera.zoom;
    const y = camera.y + node.position.y * camera.zoom;
    const width = (node.width || 0) * camera.zoom;
    const height = (node.height || 0) * camera.zoom;
    if (point.x < x - 4 || point.x > x + width + 4 ||
        point.y < y - 4 || point.y > y + height + 4) continue;
    const distance = Math.hypot(point.x - x - width / 2, point.y - y - height / 2);
    if (distance < nearestNodeDistance) {
      nearestNode = node;
      nearestNodeDistance = distance;
    }
  }
  if (nearestNode) return { node: nearestNode };

  let nearestEdge: RelationshipEdgeType | undefined;
  let edgeDistance = 3;
  for (const edge of edges) {
    const points = edge.data?.route?.points;
    if (!points) continue;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      const ax = camera.x + a.x * camera.zoom;
      const ay = camera.y + a.y * camera.zoom;
      const bx = camera.x + b.x * camera.zoom;
      const by = camera.y + b.y * camera.zoom;
      const dx = bx - ax, dy = by - ay;
      const fraction = Math.max(0, Math.min(1,
        ((point.x - ax) * dx + (point.y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const distance = Math.hypot(point.x - ax - fraction * dx,
        point.y - ay - fraction * dy);
      if (distance < edgeDistance) {
        nearestEdge = edge;
        edgeDistance = distance;
      }
    }
  }
  return nearestEdge ? { edge: nearestEdge } : null;
}
