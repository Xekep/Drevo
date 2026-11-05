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
  type Contacts = Map<string, { contacts: Set<string>; crossings: Set<string> }>;
  let contactCache = new WeakMap<Point[], Map<string, Contacts>>();
  const contacts = (points: Point[], branch: UnionBranch) => {
    const cached = contactCache.get(points)?.get(branch.union);
    if (cached) return cached;
    const found: Contacts = new Map();
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
    const entry = contactCache.get(points) || new Map<string, Contacts>();
    entry.set(branch.union, found);
    contactCache.set(points, entry);
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
  const byUnionBranches = new Map<string, UnionBranch[]>();
  for (const branch of branches) {
    const family = byUnionBranches.get(branch.union) || [];
    family.push(branch);
    byUnionBranches.set(branch.union, family);
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
    // Candidate checks and the complete union footprint query the same routes.
    // Foreign routes stay fixed within one group, but earlier groups may have
    // replaced them: never reuse these contacts across groups or layout calls.
    contactCache = new WeakMap();
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
    const footprint = (replacement?: Map<string, Point[]>) => {
      const byBranch: Contacts = new Map(), byUnion: Contacts = new Map();
      const add = (target: Contacts, id: string, counts: { contacts: Set<string>; crossings: Set<string> }) => {
        const list = target.get(id) || { contacts: new Set<string>(), crossings: new Set<string>() };
        counts.contacts.forEach((key) => list.contacts.add(key));
        counts.crossings.forEach((key) => list.crossings.add(key));
        target.set(id, list);
      };
      for (const member of byUnionBranches.get(siblings[0].union)!) {
        const branch = current.get(member.id)!;
        for (const [id, counts] of contacts(replacement?.get(member.id) || branch.route.points, branch)) {
          add(byBranch, id, counts);
          add(byUnion, current.get(id)!.union, counts);
        }
      }
      return { byBranch, byUnion };
    };
    const noMoreContacts = (after: Contacts, before: Contacts) => [...after].every(([id, counts]) =>
      counts.contacts.size <= (before.get(id)?.contacts.size || 0) &&
      counts.crossings.size <= (before.get(id)?.crossings.size || 0));
    const familyBefore = footprint();
    for (const y of candidates) {
      const routes = siblings.map((branch) => {
        const end = branch.route.points.at(-1)!;
        return simplifyRoute([start, { x: start.x, y }, { x: end.x, y }, end]);
      });
      if (routes.some((points, i) => !clear(points) ||
          distance(points) > distance(siblings[i].route.points) + 0.01)) continue;
      const familyAfter = footprint(new Map(siblings.map((branch, i) => [branch.id, routes[i]])));
      // A shared bus is one visible route, even if several child paths contain
      // it. Compare the complete family against each foreign branch and union;
      // an individual child gaining the already shared crossing is not a new hit.
      if (!noMoreContacts(familyAfter.byBranch, familyBefore.byBranch) ||
          !noMoreContacts(familyAfter.byUnion, familyBefore.byUnion)) continue;
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
