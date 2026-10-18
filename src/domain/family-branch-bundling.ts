import { bounds, segmentContact, segmentHitsBox, simplifyRoute, Spatial, type Box } from "./edge-routing.ts";
import { segmentsCross, type Point } from "./layout-order.ts";
import type { TreeGeometry } from "./tree-layout.ts";
import type { UnionBranch } from "./union-layout.ts";

const distance = (points: Point[]) => points.slice(1).reduce((sum, p, i) =>
  sum + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y), 0);

/** Share one sibling corridor only within the same union, junction and generation. */
export function bundleFamilyBranches(geometry: TreeGeometry): TreeGeometry {
  const branches = geometry.branches;
  if (geometry.mode !== "generations" || !branches?.length || !geometry.nodeSize) return geometry;
  const { width, height } = geometry.nodeSize;
  const levels = new Map((geometry.generationBands || []).flatMap((band) =>
    band.members.map((id) => [id, band.level] as const)));
  const cards = new Spatial<Box>();
  for (const [, p] of geometry.positions)
    cards.add({ left: p.x - 8, right: p.x + width + 8, top: p.y - 8, bottom: p.y + height + 8 });
  type Segment = Box & { a: Point; b: Point; branch: UnionBranch };
  const lines = new Spatial<Segment>();
  const current = new Map(branches.map((branch) => [branch.id, branch]));
  const index = (branch: UnionBranch) => {
    const points = branch.route.points;
    for (let i = 1; i < points.length; i++)
      if (distance([points[i - 1], points[i]]))
        lines.add({ ...bounds(points[i - 1], points[i]), a: points[i - 1], b: points[i], branch });
  };
  branches.forEach(index);
  const contacts = (points: Point[], branch: UnionBranch) => {
    const found = new Map<string, { contacts: Set<string>; crossings: Set<string> }>();
    for (let i = 1; i < points.length; i++)
      for (const line of lines.query(bounds(points[i - 1], points[i]))) {
        if (line.branch.union === branch.union || current.get(line.branch.id) !== line.branch) continue;
        const contact = segmentContact(points[i - 1], points[i], line.a, line.b);
        if (!contact) continue;
        const list = found.get(line.branch.id) || { contacts: new Set<string>(), crossings: new Set<string>() };
        list.contacts.add(contact);
        if (segmentsCross([points[i - 1], points[i]], [line.a, line.b])) list.crossings.add(contact);
        found.set(line.branch.id, list);
      }
    return found;
  };
  const clear = (points: Point[]) => {
    const trimmed = points.map((p) => ({ ...p }));
    for (const [i, j] of [[0, 1], [trimmed.length - 1, trimmed.length - 2]]) {
      const a = trimmed[i], b = trimmed[j];
      if (distance([a, b]) < 8) return false;
      a.x += Math.sign(b.x - a.x) * 8;
      a.y += Math.sign(b.y - a.y) * 8;
    }
    return trimmed.slice(1).every((b, i) =>
      !cards.query(bounds(trimmed[i], b)).some((box) => segmentHitsBox(trimmed[i], b, box)));
  };
  const groups = new Map<string, UnionBranch[]>();
  for (const branch of branches) {
    const points = branch.route.points, start = points[0], end = points.at(-1);
    const level = levels.get(branch.target);
    if (!branch.id.startsWith("child:") || !start || !end || level === undefined ||
        !["top", "bottom"].includes(branch.route.sourceHandle) ||
        branch.route.targetHandle !== (branch.route.sourceHandle === "bottom" ? "top" : "bottom")) continue;
    const key = JSON.stringify([branch.union, start.x, start.y, level, branch.route.sourceHandle]);
    const group = groups.get(key) || [];
    group.push(branch);
    groups.set(key, group);
  }
  let changed = false;
  for (const siblings of groups.values()) {
    if (siblings.length < 2) continue;
    const start = siblings[0].route.points[0];
    const sign = siblings[0].route.sourceHandle === "bottom" ? 1 : -1;
    const nearest = Math.min(...siblings.map((b) => sign * (b.route.points.at(-1)!.y - start.y)));
    if (nearest < 48) continue;
    const middle = start.y + sign * nearest / 2;
    const existing = siblings.flatMap((b) => b.route.points.slice(1).flatMap((p, i) =>
      p.y === b.route.points[i].y && p.x !== b.route.points[i].x ? [p.y] : []));
    const candidates = [...new Set([middle, ...existing])]
      .filter((y) => sign * (y - start.y) >= 24 && sign * (y - start.y) <= nearest - 24)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || sign * (a - b))
      .slice(0, 12);
    const before = siblings.map((b) => contacts(b.route.points, b));
    for (const y of candidates) {
      const routes = siblings.map((branch) => {
        const end = branch.route.points.at(-1)!;
        return simplifyRoute([start, { x: start.x, y }, { x: end.x, y }, end]);
      });
      if (routes.some((points, i) => !clear(points) ||
          distance(points) > distance(siblings[i].route.points) + 0.01 ||
          [...contacts(points, siblings[i])].some(([id, counts]) =>
            counts.contacts.size > (before[i].get(id)?.contacts.size || 0) ||
            counts.crossings.size > (before[i].get(id)?.crossings.size || 0)))) continue;
      siblings.forEach((branch, i) => {
        const updated = { ...branch, route: { ...branch.route, points: routes[i] } };
        current.set(branch.id, updated);
        index(updated);
      });
      changed = true;
      break;
    }
  }
  return changed ? { ...geometry, branches: branches.map((b) => current.get(b.id)!) } : geometry;
}
