import {
  bounds,
  segmentContact,
  Spatial,
  type Box,
  type EdgeRoute,
} from "./edge-routing.ts";
import { segmentsCross, type Point } from "./layout-order.ts";

export type RoutedGroup = { group: string; route: EdgeRoute };
/** Общая семейная шина считается один раз, Т-касания чужой линии — конфликтом. */
export function routingQuality(edges: RoutedGroup[]) {
  const lines = new Spatial<Box & { a: Point; b: Point; group: string }>();
  const contacts = new Set<string>(),
    crossings = new Set<string>(),
    groups = new Map<string, number>();
  let length = 0,
    bends = 0;
  for (const edge of edges) {
    const points = edge.route.points;
    let previous = "";
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      const size = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (!size) continue;
      length += size;
      const direction = a.x === b.x ? "v" : "h";
      if (previous && previous !== direction) bends++;
      previous = direction;
      for (const line of lines.query(bounds(a, b))) {
        if (line.group === edge.group) continue;
        const contact = segmentContact(a, b, line.a, line.b);
        if (!contact) continue;
        const key = JSON.stringify([[edge.group, line.group].sort(), contact]);
        if (!contacts.has(key)) {
          contacts.add(key);
          for (const group of [edge.group, line.group])
            groups.set(group, (groups.get(group) || 0) + 1);
        }
        if (segmentsCross([a, b], [line.a, line.b])) crossings.add(key);
      }
      lines.add({ ...bounds(a, b), a, b, group: edge.group });
    }
  }
  return {
    length,
    bends,
    contacts: contacts.size,
    crossings: crossings.size,
    groups,
  };
}

export function routingCost(q: ReturnType<typeof routingQuality>) {
  return q.length + q.bends * 16 + q.contacts * 1800;
}
