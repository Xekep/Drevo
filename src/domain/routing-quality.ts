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
export function routingContactScore(edges: RoutedGroup[]) {
  const lines = new Spatial<Box & { a: Point; b: Point; group: number }>();
  const contacts = new Set<string>(),
    crossings = new Set<string>(),
    groups = new Map<string, number>();
  const groupIds = new Map<string, number>();
  const groupNames: string[] = [];
  let length = 0,
    bends = 0,
    segments = 0;
  for (const edge of edges) {
    let group = groupIds.get(edge.group);
    if (group === undefined) {
      group = groupIds.size;
      groupIds.set(edge.group, group);
      groupNames.push(edge.group);
    }
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
        if (line.group === group) continue;
        const contact = segmentContact(a, b, line.a, line.b);
        if (!contact) continue;
        // Для выбора seed сохраняем также число всех пар сегментов, до дедупликации.
        segments++;
        const first = Math.min(group, line.group);
        const second = Math.max(group, line.group);
        const key = `${first}:${second}:${contact}`;
        if (!contacts.has(key)) {
          contacts.add(key);
          groups.set(edge.group, (groups.get(edge.group) || 0) + 1);
          const other = groupNames[line.group];
          groups.set(other, (groups.get(other) || 0) + 1);
        }
        if (segmentsCross([a, b], [line.a, line.b])) crossings.add(key);
      }
      lines.add({ ...bounds(a, b), a, b, group });
    }
  }
  return {
    contacts: { distinct: contacts.size, segments },
    quality: {
      length,
      bends,
      contacts: contacts.size,
      crossings: crossings.size,
      groups,
    },
  };
}

export function routingQuality(edges: RoutedGroup[]) {
  return routingContactScore(edges).quality;
}

export function routingCost(q: ReturnType<typeof routingQuality>) {
  return q.length + q.bends * 16 + q.contacts * 1800;
}
