import type { Person } from "./types.ts";
import type { TreeGeometry } from "./tree-layout.ts";
import type { DepthBranch, DepthConnection } from "./tree-depth.ts";
import { householdLevels } from "./household-levels.ts";

export type DepthPoint = { x: number; y: number; z: number };
export type DepthScene = {
  branch: DepthBranch;
  points: Map<string, DepthPoint>;
  connections: DepthConnection[];
};
export const DEPTH_PREVIEW_LIMIT = 18;

/** Geometry only: a bounded view of each accessible branch, attached to real relatives. */
export function depthWorld(
  branches: DepthBranch[], people: ReadonlyMap<string, Person>,
  geometry: TreeGeometry, anchorId: string,
) {
  const front = new Map<string, DepthPoint>();
  const occurrences = new Map(geometry.occurrences?.map((item) => [item.id, item.personId]));
  for (const [id, position] of geometry.positions) {
    const personId = occurrences.get(id) || id;
    if (!front.has(personId)) front.set(personId, {
      x: position.x + (geometry.nodeSize?.width || 220) / 2,
      y: position.y + (geometry.nodeSize?.height || 264) / 2, z: 0,
    });
  }
  const pivot = front.get(anchorId) || front.values().next().value || { x: 0, y: 0, z: 0 };
  const scenes: DepthScene[] = [];
  const attachmentSlots = new Map<string, number>();
  type Rect = { left: number; top: number; right: number; bottom: number };
  const cells = new Map<string, Rect[]>();
  const keys = (box: Rect) => {
    const result: string[] = [];
    for (let x = Math.floor(box.left / 512); x <= Math.floor(box.right / 512); x++)
      for (let y = Math.floor(box.top / 512); y <= Math.floor(box.bottom / 512); y++) result.push(`${x}:${y}`);
    return result;
  };
  const occupy = (box: Rect) => {
    for (const key of keys(box)) cells.set(key, [...(cells.get(key) || []), box]);
  };
  const overlaps = (box: Rect) => keys(box).some((key) => cells.get(key)?.some((other) =>
    box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top));
  const cardBox = (point: DepthPoint): Rect => {
    const p = projectDepth(point, pivot, 0);
    return { left: p.x - 150, right: p.x + 150, top: p.y - 75, bottom: p.y + 205 };
  };
  for (const point of front.values()) occupy({ left: point.x - 120, right: point.x + 120,
    top: point.y - 142, bottom: point.y + 142 });
  for (const branch of branches) {
    const members = new Set(branch.members);
    const neighbors = new Map(branch.members.map((id) => [id, new Set<string>()]));
    const connections = branch.connections.filter((edge) => members.has(edge.from) && members.has(edge.to));
    for (const edge of connections) {
      neighbors.get(edge.from)!.add(edge.to); neighbors.get(edge.to)!.add(edge.from);
    }
    // Breadth first keeps the connection to the front in view, even for large branches.
    const queue = [branch.anchorId], seen = new Set(queue);
    for (let i = 0; i < queue.length && queue.length < DEPTH_PREVIEW_LIMIT; i++)
      for (const near of neighbors.get(queue[i]) || []) {
        if (seen.has(near) || queue.length >= DEPTH_PREVIEW_LIMIT) continue;
        seen.add(near); queue.push(near);
      }
    const preview = queue.map((id) => people.get(id)).filter((p): p is Person => !!p);
    const known = new Set(preview.map((p) => p.id));
    const levels = householdLevels(preview.map((p) => ({ ...p,
      parents: p.parents.filter((id) => known.has(id)), spouses: p.spouses.filter((id) => known.has(id)),
    })));
    const rows = new Map<number, Person[]>();
    for (const p of preview) {
      const level = levels.get(p.id) || 0;
      rows.set(level, [...(rows.get(level) || []), p]);
    }
    const local = new Map<string, { x: number; y: number }>();
    for (const [level, row] of rows) [...row].sort((a, b) =>
      Number(b.id === branch.anchorId) - Number(a.id === branch.anchorId)).forEach((p, i) => local.set(p.id, {
      x: i * 350,
      y: level * 320 * (geometry.reverse ? -1 : 1),
    }));
    const root = local.get(branch.anchorId);
    if (!root) continue;
    const connection = branch.connections.find((edge) => front.has(edge.from) || front.has(edge.to));
    const frontId = connection ? (front.has(connection.from) ? connection.from : connection.to) : "";
    const base = front.get(frontId) || pivot;
    const slot = attachmentSlots.get(frontId) || 0;
    attachmentSlots.set(frontId, slot + 1);
    const side = slot % 2 ? 1 : -1, ring = Math.floor(slot / 2);
    const parentStep = connection?.type === "parent"
      ? (front.has(connection.from) ? 1 : -1) * (geometry.reverse ? -1 : 1) : 0;
    const origin = {
      x: base.x + side * (360 + ring * 720),
      y: base.y + parentStep * 240 + (connection ? 0 : 240) + ring * 160,
      z: -380 - ring * 300 - (connection ? 0 : 180),
    };
    const rootProjection = projectDepth(origin, pivot, 0);
    const points = new Map<string, DepthPoint>(preview.map((p) => {
      const point = local.get(p.id)!;
      const dy = point.y - root.y;
      const dx = point.x - root.x;
      const z = origin.z - Math.abs(dy) * .2 - Math.abs(dx) * .24;
      const scale = projectDepth({ x: pivot.x, y: pivot.y, z }, pivot, 0).scale;
      // Solve the resting projection for readable row spacing. Perspective is
      // retained in Z and becomes visible while orbiting, without squashing text.
      return [p.id, {
        x: pivot.x + (rootProjection.x + side * dx * (320 / 350) - pivot.x) / scale,
        y: pivot.y + ((rootProjection.y + dy * (300 / 320) - pivot.y) / scale + z * .17) / .985,
        z,
      }] as const;
    }));
    for (let attempt = 0; attempt < 24 && [...points.values()].some((p) => overlaps(cardBox(p))); attempt++)
      for (const point of points.values()) {
        if (connection) point.x += side * 380;
        else point.y += 380;
      }
    for (const point of points.values()) occupy(cardBox(point));
    scenes.push({ branch, points, connections: connections.filter((edge) => known.has(edge.from) && known.has(edge.to)) });
  }
  return { pivot, front, scenes };
}

/** Perspective moves branches through X/Y/Z; labels remain upright billboards. */
export function projectDepth(point: DepthPoint, pivot: DepthPoint, yaw: number) {
  const dx = point.x - pivot.x, dy = point.y - pivot.y;
  const angle = yaw * Math.PI / 180;
  const z = point.z * Math.cos(angle) - dx * Math.sin(angle);
  const scale = Math.max(.38, Math.min(1.12, 2100 / (2100 - z)));
  return { x: pivot.x + (dx * Math.cos(angle) + point.z * Math.sin(angle)) * scale,
    y: pivot.y + (dy * .985 - z * .17) * scale, scale, z };
}
