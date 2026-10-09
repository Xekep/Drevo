import {
  bounds,
  segmentContact,
  Spatial,
  type Box,
  type EdgeRoute,
} from "./edge-routing.ts";
import { segmentsCross, type Point } from "./layout-order.ts";
import type { routingContactScore } from "./routing-quality.ts";

type Edge = { id: string; group: string; route: EdgeRoute };
type Segment = Box & {
  a: Point;
  b: Point;
  group: number;
  owner: string;
  ordinal: number;
};
type Contact = {
  count: number;
  crossingCount: number;
  first: number;
  second: number;
};
type Index = {
  edges: Map<string, Edge>;
  groups: Map<string, number>;
  names: string[];
  lines: Spatial<Segment>;
  segments: Segment[];
  contacts: Map<string, Contact>;
  pairs: number;
  bends: number;
  measures: Map<string, { sizes: number[]; bends: number }>;
  score: ReturnType<typeof routingContactScore>;
};

/** Exact delta scoring for local moves. Portfolio/large changes use a full scan.
 * Unchanged route pairs retain their multiplicity, T contacts and crossings.
 * Only one index lives per layout; no process-wide geometry/route cache.
 */
export function incrementalRouteScorer() {
  let previous: Index | undefined;
  return (edges: Edge[]): ReturnType<typeof routingContactScore> => {
    const byId = new Map(edges.map((edge) => [edge.id, edge]));
    const ordered =
      previous?.edges.size === edges.length &&
      [...previous.edges.keys()].every((id, i) => id === edges[i].id);
    const changed = new Set<string>();
    if (previous) {
      for (const [id, edge] of previous.edges)
        if (
          byId.get(id)?.route !== edge.route ||
          byId.get(id)?.group !== edge.group
        )
          changed.add(id);
      for (const edge of edges)
        if (!previous.edges.has(edge.id)) changed.add(edge.id);
      if (!changed.size && ordered) return previous.score;
    }
    const reuse =
      previous &&
      ordered &&
      edges.length > 200 &&
      changed.size <= 40 &&
      changed.size <= edges.length / 10;
    const names = reuse ? [...previous!.names] : [];
    const groups = reuse
      ? new Map(previous!.groups)
      : new Map<string, number>();
    const lines = new Spatial<Segment>(),
      segments: Segment[] = [];
    const measures = reuse
      ? new Map(previous!.measures)
      : new Map<string, { sizes: number[]; bends: number }>();
    let length = 0,
      bends = reuse ? previous!.bends : 0;
    if (reuse)
      for (const id of changed) {
        const old = measures.get(id);
        bends -= old?.bends || 0;
        measures.delete(id);
      }
    for (const edge of edges) {
      if (reuse && !changed.has(edge.id)) continue;
      let group = groups.get(edge.group);
      if (group === undefined) {
        group = names.length;
        groups.set(edge.group, group);
        names.push(edge.group);
      }
      let direction = "";
      const measure = { sizes: [] as number[], bends: 0 };
      const points = edge.route.points;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i];
        const size = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (!size) continue;
        measure.sizes.push(size);
        const next = a.x === b.x ? "v" : "h";
        if (direction && direction !== next) {
          bends++;
          measure.bends++;
        }
        direction = next;
        const segment = {
          ...bounds(a, b),
          a,
          b,
          group,
          owner: edge.id,
          ordinal: segments.length,
        };
        segments.push(segment);
        lines.add(segment);
      }
      measures.set(edge.id, measure);
    }
    // Preserve the full scorer's addition order for fractional coordinates.
    // Subtracting a changed route from an aggregate changes floating-point
    // rounding and can otherwise break ties between geometry candidates.
    for (const edge of edges)
      for (const size of measures.get(edge.id)!.sizes) length += size;
    const contacts = reuse
      ? new Map(previous!.contacts)
      : new Map<string, Contact>();
    let pairs = reuse ? previous!.pairs : 0;
    const pair = (segment: Segment, other: Segment, delta: 1 | -1) => {
      if (segment.group === other.group) return;
      const contact = segmentContact(segment.a, segment.b, other.a, other.b);
      if (!contact) return;
      pairs += delta;
      const first = Math.min(segment.group, other.group),
        second = Math.max(segment.group, other.group);
      const key = `${first}:${second}:${contact}`,
        old = contacts.get(key);
      const count = (old?.count || 0) + delta;
      if (!count) {
        contacts.delete(key);
        return;
      }
      const crossingCount =
        (old?.crossingCount || 0) +
        delta *
          Number(segmentsCross([segment.a, segment.b], [other.a, other.b]));
      contacts.set(key, { first, second, count, crossingCount });
    };
    const apply = (
      source: { lines: Spatial<Segment>; segments: Segment[] },
      delta: 1 | -1,
      partial: boolean,
    ) => {
      for (const segment of source.segments) {
        if (partial && !changed.has(segment.owner)) continue;
        for (const other of source.lines.query(segment)) {
          if (
            segment.group === other.group ||
            ((!partial || changed.has(other.owner)) &&
              other.ordinal >= segment.ordinal)
          )
            continue;
          pair(segment, other, delta);
        }
      }
    };
    if (reuse) apply(previous!, -1, true);
    apply({ lines, segments }, 1, !!reuse);
    if (reuse)
      for (const segment of segments)
        for (const other of previous!.lines.query(segment))
          if (!changed.has(other.owner)) pair(segment, other, 1);
    let crossings = 0;
    const groupContacts = new Map<string, number>();
    for (const contact of contacts.values()) {
      if (contact.crossingCount > 0) crossings++;
      for (const group of [contact.first, contact.second]) {
        const name = names[group];
        groupContacts.set(name, (groupContacts.get(name) || 0) + 1);
      }
    }
    const score = {
      contacts: { distinct: contacts.size, segments: pairs },
      quality: {
        length,
        bends,
        contacts: contacts.size,
        crossings,
        groups: groupContacts,
      },
    };
    // Keep the full anchor immutable. Local candidates overlay only changed
    // segments; building another index for thousands of unchanged lines is waste.
    if (!reuse)
      previous = {
        edges: byId,
        groups,
        names,
        lines,
        segments,
        contacts,
        pairs,
        bends,
        measures,
        score,
      };
    return score;
  };
}
