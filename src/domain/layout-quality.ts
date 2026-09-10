import type { ElkNode } from "elkjs";
import { crossingPaths } from "./route-crossings.ts";

/** Стоимость всей композиции, а не одной её стороны. */
export function layoutQuality(graph: ElkNode) {
  const nodes = graph.children || [];
  const width = nodes.length
    ? Math.max(...nodes.map((n) => n.x! + n.width!)) -
      Math.min(...nodes.map((n) => n.x!))
    : 0;
  const height = nodes.length
    ? Math.max(...nodes.map((n) => n.y! + n.height!)) -
      Math.min(...nodes.map((n) => n.y!))
    : 0;
  let totalLength = 0,
    longest = 0;
  const routes = (graph.edges || []).flatMap((edge) => {
    let length = 0;
    const sections = (edge.sections || []).map((section, i) => {
      const points = [
        section.startPoint,
        ...(section.bendPoints || []),
        section.endPoint,
      ];
      for (let j = 1; j < points.length; j++)
        length += Math.hypot(
          points[j].x - points[j - 1].x,
          points[j].y - points[j - 1].y,
        );
      return {
        id: `${edge.id}:${i}`,
        group: JSON.stringify(edge.sources),
        route: {
          points,
          sourceHandle: "bottom" as const,
          targetHandle: "top" as const,
        },
      };
    });
    totalLength += length;
    longest = Math.max(longest, length);
    return sections;
  });
  return {
    width,
    height,
    area: width * height,
    extent: Math.max(width, height),
    totalLength,
    longest,
    crossedRoutes: crossingPaths(routes).size,
  };
}

type Quality = ReturnType<typeof layoutQuality>;
export function layoutCost(after: Quality, before: Quality) {
  const ratio = (a: number, b: number) => a / Math.max(1, b);
  return (
    0.3 * ratio(after.extent, before.extent) +
    0.3 * ratio(after.area, before.area) +
    0.25 * ratio(after.totalLength, before.totalLength) +
    0.15 * ratio(after.longest, before.longest)
  );
}

/** Обязательная сохранность карточек, их размеров и всех рассчитанных связей. */
export function completeLayout(candidate: ElkNode, baseline: ElkNode) {
  const nodes = new Map(baseline.children?.map((n) => [n.id, n]));
  const edges = new Map(baseline.edges?.map((e) => [e.id, e]));
  return (
    candidate.children?.length === nodes.size &&
    new Set(candidate.children.map((n) => n.id)).size === nodes.size &&
    candidate.children.every(
      (n) =>
        nodes.has(n.id) &&
        [n.x, n.y, n.width, n.height].every(Number.isFinite) &&
        n.width === nodes.get(n.id)!.width &&
        n.height === nodes.get(n.id)!.height,
    ) &&
    candidate.edges?.length === edges.size &&
    new Set(candidate.edges.map((e) => e.id)).size === edges.size &&
    candidate.edges.every((e) => {
      const previous = edges.get(e.id);
      return (
        previous &&
        JSON.stringify(e.sources) === JSON.stringify(previous.sources) &&
        JSON.stringify(e.targets) === JSON.stringify(previous.targets) &&
        (!previous.sections?.length || !!e.sections?.length) &&
        (e.sections || []).every((s) =>
          [s.startPoint, ...(s.bendPoints || []), s.endPoint].every(
            (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
          ),
        )
      );
    })
  );
}
