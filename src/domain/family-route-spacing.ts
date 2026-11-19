import { bounds, segmentContact, segmentHitsBox, Spatial, type Box } from "./edge-routing.ts";
import { segmentsCross, type Point } from "./layout-order.ts";
import { routingQuality } from "./routing-quality.ts";
import type { TreeGeometry } from "./tree-layout.ts";
import { treeNodeSize } from "./tree-layout-constants.ts";

const CLEARANCE = 20;
const MIN_OVERLAP = 48;
const MAX_SHIFT = 16;
const MAX_CANDIDATES = 256;

type Segment = Box & { route: number; end: number };
type Channel = Box & { union: string; y: number; offset: number; parts: Segment[]; movable: boolean };

/** A sibling corridor moves as a unit, after card and route placement are finished. */
export function spaceFamilyRoutes(geometry: TreeGeometry, size = geometry.nodeSize || treeNodeSize()): TreeGeometry {
  const branches = geometry.branches;
  if (!branches || branches.length < 2) return geometry;
  const routes = [...branches.map(b => b.route), ...(geometry.routes || []).map(([, route]) => route)];
  const current = routes.map(route => route.points);
  const segments = current.map((points, route) => points.slice(1).map((b, index): Segment =>
    ({ ...bounds(points[index], b), route, end: index + 1 })));
  const byHeight = new Map<string, Segment[]>();
  branches.forEach((branch, route) => {
    for (const part of segments[route]) {
      if (part.left === part.right || part.top !== part.bottom) continue;
      const key = JSON.stringify([branch.union, part.top]);
      const parts = byHeight.get(key) || [];
      parts.push(part);
      byHeight.set(key, parts);
    }
  });
  const channels: Channel[] = [];
  const heights = new Spatial<Channel>();
  for (const parts of byHeight.values()) {
    let channel: Channel | undefined;
    for (const part of parts.sort((a, b) => a.left - b.left || a.right - b.right)) {
      const { end, route, top: y } = part;
      const movable = branches[route].id.startsWith("child:") && end >= 2 && end < segments[route].length &&
        segments[route][end - 2].left === segments[route][end - 2].right &&
        segments[route][end].left === segments[route][end].right;
      if (channel && part.left <= channel.right) {
        channel.right = Math.max(channel.right, part.right);
        channel.movable &&= movable;
        channel.parts.push(part);
      } else {
        channel = { ...part, y, offset: 0, union: branches[route].union, parts: [part], movable };
        channels.push(channel);
      }
    }
  }
  const direction = geometry.reverse ? -1 : 1;
  channels.sort((a, b) => direction * (a.y - b.y) || a.left - b.left || a.right - b.right || a.union.localeCompare(b.union));
  const overlap = (a: Channel, b: Channel) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const neighbors = (channel: Channel, radius: number) => heights.query({
    ...channel, top: channel.y - radius, bottom: channel.y + radius,
  }).filter(other => other.union !== channel.union && overlap(channel, other) >= MIN_OVERLAP);
  const conflicts: { upper: Channel; lower: Channel; weight: number }[] = [];
  for (const lower of channels) {
    for (const upper of neighbors(lower, CLEARANCE)) {
      const gap = Math.abs(lower.y - upper.y);
      if ((upper.movable || lower.movable) && gap < CLEARANCE)
        conflicts.push({ upper, lower, weight: overlap(upper, lower) * (CLEARANCE - gap) });
    }
    heights.add(lower);
  }
  if (!conflicts.length) return geometry;
  conflicts.sort((a, b) => b.weight - a.weight);

  // Index the full range each segment can occupy, so accepted moves do not
  // need to rebuild the spatial index or leave obsolete segments behind.
  const lines = new Spatial<Segment>();
  segments.forEach((parts, route) => {
    const padding = route < branches.length ? MAX_SHIFT : 0;
    for (const part of parts)
      lines.add({ ...part, top: part.top - padding, bottom: part.bottom + padding });
  });
  const cards = new Spatial<Box>();
  for (const [, p] of geometry.positions)
    cards.add({ left: p.x, right: p.x + size.width, top: p.y, bottom: p.y + size.height });
  const segmentPoints = (part: Segment, points: Point[]): [Point, Point] => [points[part.end - 1], points[part.end]];
  const canMove = (moves: ReadonlyMap<Channel, number>) => {
    const replacements = new Map<number, Point[]>();
    const changed = new Set<Segment>();
    for (const [channel, offset] of moves) {
      if (!channel.movable || Math.abs(offset) > MAX_SHIFT) return;
      for (const other of neighbors(channel, CLEARANCE + MAX_SHIFT * 2)) {
        const before = Math.abs(channel.y + channel.offset - other.y - other.offset);
        const after = Math.abs(channel.y + offset - other.y - (moves.get(other) ?? other.offset));
        if (after < CLEARANCE && after < before) return;
      }
      for (const { route, end } of channel.parts) {
        const points = replacements.get(route) || [...current[route]];
        const y = channel.y + offset;
        points[end - 1] = { ...points[end - 1], y };
        points[end] = { ...points[end], y };
        replacements.set(route, points);
        for (const part of segments[route].slice(end - 2, end + 1)) changed.add(part);
      }
    }
    for (const part of changed) {
      const before = segmentPoints(part, current[part.route]);
      const after = segmentPoints(part, replacements.get(part.route)!);
      const [a, b] = after;
      if (a.x === b.x) {
        const oldLength = before[1].y - before[0].y;
        if (Math.sign(oldLength) * (b.y - a.y) < Math.min(8, Math.abs(oldLength))) return;
      }
      const box = bounds(a, b);
      if (cards.query(box).some(card => segmentHitsBox(a, b, card))) return;
      for (const other of lines.query({ ...box,
        top: Math.min(box.top, before[0].y, before[1].y),
        bottom: Math.max(box.bottom, before[0].y, before[1].y) })) {
        if (other.route === part.route && Math.abs(other.end - part.end) <= 1) continue;
        const oldOther = segmentPoints(other, current[other.route]);
        const newOther = segmentPoints(other, replacements.get(other.route) ?? current[other.route]);
        const oldContact = contact(before, oldOther);
        const newContact = contact(after, newOther);
        const crossing = newContact === "crossing";
        if (newContact && (!oldContact || crossing !== (oldContact === "crossing"))) return;
        // Moving a shared bus must also preserve its junctions with the rest of its family.
        const sameFamily = branches[part.route].union === branches[other.route]?.union;
        if (sameFamily && Boolean(newContact) !== Boolean(oldContact)) return;
        if (!sameFamily && newContact && !crossing && newContact !== oldContact) return;
      }
    }
    return replacements;
  };

  let attempts = 0;
  const separate = (upper: Channel, lower: Channel, needed: number) => {
    const up = upper.movable ? MAX_SHIFT + direction * upper.offset : 0;
    const down = lower.movable ? MAX_SHIFT - direction * lower.offset : 0;
    // Prefer a split shift. In crowded channels try either line independently,
    // then smaller movements that still make the gap more legible.
    for (const step of [needed, needed / 2, needed / 4]) {
      if (step > up + down) continue;
      const tried = new Set<number>();
      for (const fraction of [0.5, 1, 0, 0.75, 0.25]) {
        const above = Math.min(up, Math.max(step * fraction, step - down));
        const below = Math.min(down, step - above);
        if (tried.has(above)) continue;
        tried.add(above);
        if (attempts >= MAX_CANDIDATES) return false;
        attempts++;
        const moves = new Map<Channel, number>();
        if (above) moves.set(upper, upper.offset - direction * above);
        if (below) moves.set(lower, lower.offset + direction * below);
        const replacements = canMove(moves);
        if (!replacements) continue;
        for (const [route, points] of replacements) current[route] = points;
        for (const [channel, offset] of moves) channel.offset = offset;
        return true;
      }
    }
    return false;
  };
  for (const { upper, lower } of conflicts) {
    if (attempts >= MAX_CANDIDATES) break;
    const gap = direction * (lower.y + lower.offset - upper.y - upper.offset);
    if (Math.abs(gap) >= CLEARANCE) continue;
    if (gap < 0) separate(lower, upper, CLEARANCE + gap);
    else if (!separate(upper, lower, CLEARANCE - gap) && gap === 0)
      separate(lower, upper, CLEARANCE);
  }
  if (branches.every((branch, index) => branch.route.points === current[index])) return geometry;
  const spaced = branches.map((branch, index) => branch.route.points === current[index] ? branch :
    { ...branch, route: { ...branch.route, points: current[index] } });
  // A crossing shared by several segments is counted once on the canvas.
  // Make sure moving its participants did not turn it into separate crossings.
  const quality = (group: typeof branches) => routingQuality([
    ...group.map(b => ({ group: `family:${b.union}`, route: b.route })),
    ...(geometry.routes || []).map(([id, route]) => ({ group: `extra:${id}`, route })),
  ]);
  const before = quality(branches), after = quality(spaced);
  return after.contacts <= before.contacts && after.crossings <= before.crossings
    ? { ...geometry, branches: spaced }
    : geometry;
}

function contact([a, b]: [Point, Point], [c, d]: [Point, Point]) {
  if (segmentsCross([a, b], [c, d])) return "crossing";
  if (c.x !== d.x && c.y !== d.y) return "";
  return segmentContact(a, b, c, d) ||
    ([a, b].some(p => [c, d].some(q => p.x === q.x && p.y === q.y)) ? "endpoint" : "");
}
