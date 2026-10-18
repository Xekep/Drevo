import type { DepthConnection } from "./tree-depth.ts";

export type SpatialPoint = { x: number; y: number; z: number; angle: number };
type Unit = {
  id: string;
  members: string[];
  row: number;
  order: number;
  radius: number;
  parents: Set<string>;
  children: string[];
  childSlots: Map<string, number>;
  span: number;
  x: number;
  z: number;
  angle: number;
};
const CELL = 320;

/** Vertical generation axes with centred family forks in X/Z.
 * Partners/co-parents share a local unit only in the same authoritative row.
 * Every actual person still has their own point and all original edges survive.
 * Bounded placement probes reserve disjoint per-row footprints; a strip beyond
 * the occupied extent guarantees termination even for dense imported graphs.
 */
export function spatialBranchLayout(
  flat: ReadonlyMap<string, { x: number; y: number }>,
  connections: readonly DepthConnection[],
  reverse: boolean,
): Map<string, SpatialPoint> {
  const roots = new Map([...flat.keys()].map((id) => [id, id]));
  const find = (id: string) => {
    let root = id;
    while (roots.get(root) !== root) root = roots.get(root)!;
    while (id !== root) {
      const next = roots.get(id)!;
      roots.set(id, root);
      id = next;
    }
    return root;
  };
  const join = (a: string, b: string) => {
    if (
      !flat.has(a) ||
      !flat.has(b) ||
      Math.abs(flat.get(a)!.y - flat.get(b)!.y) > 1
    )
      return;
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) roots.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const coParents = new Map<string, string>();
  for (const edge of connections) {
    if (!flat.has(edge.from) || !flat.has(edge.to)) continue;
    if (edge.type === "partner") join(edge.from, edge.to);
    else {
      const other = coParents.get(edge.to);
      if (other) join(other, edge.from);
      else coParents.set(edge.to, edge.from);
    }
  }
  const units = new Map<string, Unit>(),
    unitOf = new Map<string, Unit>();
  let top = Infinity,
    bottom = -Infinity;
  for (const [id, p] of flat) {
    const key = find(id);
    let unit = units.get(key);
    if (!unit) {
      unit = {
        id: key,
        members: [],
        row: p.y,
        order: p.x,
        radius: 140,
        parents: new Set(),
        children: [],
        childSlots: new Map(),
        span: 0,
        x: 0,
        z: 0,
        angle: 0,
      };
      units.set(key, unit);
    }
    unit.members.push(id);
    unit.order = Math.min(unit.order, p.x);
    unitOf.set(id, unit);
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y);
  }
  const order = (a: Unit, b: Unit) =>
    a.order - b.order || a.id.localeCompare(b.id);
  for (const unit of units.values()) {
    unit.members.sort(
      (a, b) => flat.get(a)!.x - flat.get(b)!.x || a.localeCompare(b),
    );
    const n = unit.members.length;
    unit.radius = n <= 4 ? 140 * (n - 1) + 130 : Math.ceil(Math.sqrt(n)) * 210;
  }
  for (const edge of connections)
    if (edge.type === "parent") {
      const a = unitOf.get(edge.from),
        b = unitOf.get(edge.to);
      if (a && b && a !== b && !b.parents.has(a.id)) {
        b.parents.add(a.id);
        a.children.push(b.id);
      }
    }
  for (const unit of units.values()) {
    unit.children.sort((a, b) => order(units.get(a)!, units.get(b)!));
    unit.childSlots = new Map(unit.children.map((id, i) => [id, i]));
    unit.span = unit.children.reduce(
      (sum, id) => sum + units.get(id)!.radius * 2 + 100,
      0,
    );
  }
  const rows = new Map<number, { occupied: Set<string>; right: number }>();
  const placed = new Set<string>();
  let founder = 0;
  const points = new Map<string, SpatialPoint>();
  for (const unit of [...units.values()].sort(
    (a, b) => (a.row - b.row) * (reverse ? -1 : 1) || order(a, b),
  )) {
    const parents = [...unit.parents]
      .filter((id) => placed.has(id))
      .sort()
      .map((id) => units.get(id)!);
    let desiredX = 0,
      desiredZ = 0;
    if (parents.length) {
      const primary = parents[0],
        siblings = primary.children;
      const index = primary.childSlots.get(unit.id)!,
        count = siblings.length;
      const width = primary.span;
      // A single continuation inherits its family's vertical axis. Only a real
      // fork uses horizontal space: balanced sectors around the parent centre,
      // rather than a forward step at every level that bends a line diagonally.
      unit.angle = primary.angle + (count > 1 ? index / count * Math.PI * 2 - Math.PI * 0.75 : 0);
      const step = count > 1 ? Math.max(
        520,
        width / (Math.PI * 2),
        unit.radius + primary.radius + 120,
      ) : 0;
      desiredX =
        parents.reduce((sum, p) => sum + p.x, 0) / parents.length +
        Math.sin(unit.angle) * step;
      desiredZ =
        parents.reduce((sum, p) => sum + p.z, 0) / parents.length +
        Math.cos(unit.angle) * step;
    } else {
      // Separate disconnected founders without inventing edges or a root person.
      const angle = founder * Math.PI * (3 - Math.sqrt(5));
      const radius = Math.sqrt(founder++) * 600;
      desiredX = Math.sin(angle) * radius;
      desiredZ = Math.cos(angle) * radius;
    }
    const rowKey = Math.round(unit.row);
    let row = rows.get(rowKey);
    if (!row) {
      row = { occupied: new Set(), right: -Infinity };
      rows.set(rowKey, row);
    }
    const radius = Math.max(0, Math.ceil((unit.radius - CELL / 2) / CELL));
    const free = (x: number, z: number) => {
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++)
          if (row!.occupied.has(`${x + dx}:${z + dz}`)) return false;
      return true;
    };
    let x = Math.round(desiredX / CELL),
      z = Math.round(desiredZ / CELL);
    if (!free(x, z)) {
      let found = false;
      // A bounded square spiral, preferred side follows the real branch direction.
      for (
        let ring = 1, probes = 0;
        ring <= 6 && !found && probes < 96;
        ring++
      ) {
        for (let dx = -ring; dx <= ring && !found && probes < 96; dx++) {
          for (const dz of [-ring, ring]) {
            probes++;
            if (free(x + dx, z + dz)) {
              x += dx;
              z += dz;
              found = true;
              break;
            }
          }
        }
        for (let dz = -ring + 1; dz < ring && !found && probes < 96; dz++) {
          for (const dx of [-ring, ring]) {
            probes++;
            if (free(x + dx, z + dz)) {
              x += dx;
              z += dz;
              found = true;
              break;
            }
          }
        }
      }
      if (!found) x = row.right + radius + 2;
    }
    for (let dx = -radius; dx <= radius; dx++)
      for (let dz = -radius; dz <= radius; dz++)
        row.occupied.add(`${x + dx}:${z + dz}`);
    row.right = Math.max(row.right, x + radius);
    unit.x = x * CELL;
    unit.z = z * CELL;
    placed.add(unit.id);
    const count = unit.members.length,
      columns = Math.ceil(Math.sqrt(count));
    unit.members.forEach((id, i) => {
      const sideways =
        count <= 4
          ? (i - (count - 1) / 2) * 280
          : ((i % columns) - (columns - 1) / 2) * 280;
      const forward =
        count <= 4
          ? 0
          : (Math.floor(i / columns) - (Math.ceil(count / columns) - 1) / 2) *
            280;
      points.set(id, {
        x:
          unit.x +
          Math.cos(unit.angle) * sideways +
          Math.sin(unit.angle) * forward,
        y: (top + bottom) / 2 - flat.get(id)!.y,
        z:
          unit.z -
          Math.sin(unit.angle) * sideways +
          Math.cos(unit.angle) * forward,
        angle: unit.angle,
      });
    });
  }
  return points;
}
