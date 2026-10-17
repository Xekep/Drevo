import type { Person, FamilyUnion } from "./types.ts";
import type { TreeGeometry } from "./tree-layout.ts";
import type { DepthBranch, DepthConnection } from "./tree-depth.ts";

export type DepthPoint = { x: number; y: number; z: number };
export type DepthCamera = {
  target: DepthPoint;
  origin: { x: number; y: number };
  yaw: number;
};
export type DepthPlane = {
  id: string;
  members: string[];
  yaw: number;
  attachment: string[];
};
export type DepthWorld = {
  points: Map<string, DepthPoint>;
  flat: Map<string, DepthPoint>;
  planes: DepthPlane[];
  planeOf: Map<string, DepthPlane>;
  connections: DepthConnection[];
};

/** One stable world from the Worker layout. Choosing a person changes the camera only. */
export function depthWorld(
  branches: DepthBranch[],
  people: ReadonlyMap<string, Person>,
  geometry: TreeGeometry,
  anchorId = "",
  unions: readonly FamilyUnion[] = [],
): DepthWorld {
  const flat = new Map<string, DepthPoint>();
  const occurrences = new Map(
    geometry.occurrences?.map((o) => [o.id, o.personId]),
  );
  for (const [id, position] of geometry.positions) {
    const personId = occurrences.get(id) || id;
    if (people.has(personId) && !flat.has(personId))
      flat.set(personId, {
        x: position.x + (geometry.nodeSize?.width || 220) / 2,
        y: position.y + (geometry.nodeSize?.height || 264) / 2,
        z: 0,
      });
  }
  const points = new Map([...flat].map(([id, p]) => [id, { ...p }]));
  const rear = new Set(branches.flatMap((branch) => branch.members));
  const main: DepthPlane = {
    id: anchorId,
    members: [...flat.keys()].filter((id) => !rear.has(id)),
    yaw: 0,
    attachment: [],
  };
  if (!main.members.includes(main.id)) main.id = main.members[0] || "";
  const planes = [main],
    planeOf = new Map(main.members.map((id) => [id, main]));
  const slots = new Map<string, number>();
  for (const branch of branches) {
    const members = branch.members.filter((id) => flat.has(id));
    if (!members.length) continue;
    const memberSet = new Set(members);
    const attachment = [
      ...new Set(
        branch.connections.flatMap(({ from, to }) =>
          memberSet.has(from) !== memberSet.has(to)
            ? [memberSet.has(from) ? to : from]
            : [],
        ),
      ),
    ].filter((id) => flat.has(id));
    // A real parent pair / partner is the hinge. Disconnected components have no hinge or invented edge.
    const hinge = attachment.length
      ? {
          x:
            attachment.reduce((sum, id) => sum + flat.get(id)!.x, 0) /
            attachment.length,
          y:
            attachment.reduce((sum, id) => sum + flat.get(id)!.y, 0) /
            attachment.length,
        }
      : flat.get(members[0])!;
    const root = flat.get(branch.anchorId) || flat.get(members[0])!;
    const slotKey = JSON.stringify([...attachment].sort());
    const slot = slots.get(slotKey) || 0;
    slots.set(slotKey, slot + 1);
    const side =
      root.x === hinge.x ? (slot % 2 ? 1 : -1) : Math.sign(root.x - hinge.x);
    const angle = attachment.length
      ? side * (48 + Math.min(2, Math.floor(slot / 2)) * 10)
      : 0;
    const radians = (angle * Math.PI) / 180;
    let nearest = Infinity;
    for (const id of members)
      nearest = Math.min(nearest, side * (flat.get(id)!.x - hinge.x));
    const shift = attachment.length ? side * Math.max(0, 440 - nearest) : 0;
    const plane: DepthPlane = {
      id: branch.anchorId,
      members,
      yaw: -angle,
      attachment,
    };
    for (const id of members) {
      const p = flat.get(id)!,
        dx = p.x + shift - hinge.x;
      points.set(id, {
        x: hinge.x + dx * Math.cos(radians),
        y: p.y,
        z: -dx * Math.sin(radians),
      });
      planeOf.set(id, plane);
    }
    planes.push(plane);
  }
  const connections: DepthConnection[] = [],
    seen = new Set<string>();
  const add = (edge: DepthConnection) => {
    if (!points.has(edge.from) || !points.has(edge.to) || edge.from === edge.to)
      return;
    const key =
      edge.type === "partner"
        ? JSON.stringify([edge.type, ...[edge.from, edge.to].sort()])
        : JSON.stringify([edge.type, edge.from, edge.to]);
    if (!seen.has(key)) {
      seen.add(key);
      connections.push(edge);
    }
  };
  for (const [id] of points) {
    const person = people.get(id)!;
    for (const parent of person.parents)
      add({ from: parent, to: id, type: "parent" });
    for (const partner of person.spouses)
      add({ from: id, to: partner, type: "partner" });
  }
  // Includes civil unions from the scoped topology, including a union crossing two planes.
  for (const branch of branches)
    for (const edge of branch.connections) add(edge);
  for (const union of unions) {
    const [from, to] = union.participants;
    add({ from, to, type: "partner" });
  }
  return { points, flat, planes, planeOf, connections };
}

export function depthCamera(
  world: DepthWorld,
  id: string,
  offset = 0,
): DepthCamera {
  const target = world.points.get(id) ||
    world.points.values().next().value || { x: 0, y: 0, z: 0 };
  const origin = world.flat.get(id) || target;
  return {
    target,
    origin: { x: origin.x, y: origin.y },
    yaw: (world.planeOf.get(id)?.yaw || 0) + offset,
  };
}

/** The same camera projects every person and every point on every family line. */
export function projectDepth(point: DepthPoint, camera: DepthCamera) {
  const dx = point.x - camera.target.x,
    dy = point.y - camera.target.y,
    dz = point.z - camera.target.z;
  const angle = (camera.yaw * Math.PI) / 180;
  const z = dz * Math.cos(angle) - dx * Math.sin(angle);
  // A weak perspective preserves generation rows; no pitch, roll or deformation of labels.
  const scale = Math.max(0.3, Math.min(1.35, 3600 / Math.max(1200, 3600 - z)));
  return {
    x: camera.origin.x + (dx * Math.cos(angle) + dz * Math.sin(angle)) * scale,
    y: camera.origin.y + dy * scale,
    scale,
    z,
  };
}

export function interpolateDepthCamera(
  from: DepthCamera,
  to: DepthCamera,
  progress: number,
): DepthCamera {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return {
    target: {
      x: mix(from.target.x, to.target.x),
      y: mix(from.target.y, to.target.y),
      z: mix(from.target.z, to.target.z),
    },
    origin: {
      x: mix(from.origin.x, to.origin.x),
      y: mix(from.origin.y, to.origin.y),
    },
    yaw: mix(from.yaw, to.yaw),
  };
}

/** Keep context labels off other people, without moving anyone's world coordinates. */
export function depthLabelMarkers(
  cards: readonly {
    id: string;
    x: number;
    y: number;
    scale: number;
    full: boolean;
  }[],
) {
  type Box = {
    id: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  const cells = new Map<string, Box[]>(),
    markers = new Set<string>();
  const box = (
    card: (typeof cards)[number],
    width: number,
    height: number,
  ): Box => ({
    id: card.id,
    left: card.x - (width * card.scale) / 2,
    right: card.x + (width * card.scale) / 2,
    top: card.y - (height * card.scale) / 2,
    bottom: card.y + (height * card.scale) / 2,
  });
  const keys = (b: Box) => {
    const result: string[] = [];
    for (let x = Math.floor(b.left / 128); x <= Math.floor(b.right / 128); x++)
      for (
        let y = Math.floor(b.top / 128);
        y <= Math.floor(b.bottom / 128);
        y++
      )
        result.push(`${x}:${y}`);
    return result;
  };
  const add = (b: Box) => {
    for (const key of keys(b)) {
      const row = cells.get(key) || [];
      row.push(b);
      cells.set(key, row);
    }
  };
  // Reserve every person's minimum hit target before spending space on labels.
  for (const card of cards)
    add(box(card, card.full ? 220 : 60, card.full ? 264 : 60));
  for (const card of cards) {
    if (card.full) continue;
    const b = box(card, 236, 104);
    const collision = keys(b).some((key) =>
      cells
        .get(key)
        ?.some(
          (other) =>
            other.id !== b.id &&
            b.left < other.right &&
            b.right > other.left &&
            b.top < other.bottom &&
            b.bottom > other.top,
        ),
    );
    if (collision) markers.add(card.id);
    else add(b);
  }
  return markers;
}

/** Place small context hit targets on screen; leaders retain the true world point. */
export function depthContextOffsets(
  cards: readonly {
    id: string;
    x: number;
    y: number;
    scale: number;
    full: boolean;
  }[],
  width: number,
  height: number,
) {
  type Box = { left: number; right: number; top: number; bottom: number };
  const cells = new Map<string, Box[]>(),
    result = new Map<string, { x: number; y: number }>();
  const keys = (b: Box) => {
    const list: string[] = [];
    for (let x = Math.floor(b.left / 128); x <= Math.floor(b.right / 128); x++)
      for (
        let y = Math.floor(b.top / 128);
        y <= Math.floor(b.bottom / 128);
        y++
      )
        list.push(`${x}:${y}`);
    return list;
  };
  const add = (b: Box) => {
    for (const key of keys(b)) {
      const row = cells.get(key) || [];
      row.push(b);
      cells.set(key, row);
    }
  };
  const collision = (b: Box) => {
    for (const key of keys(b))
      for (const other of cells.get(key) || [])
        if (
          b.left < other.right &&
          b.right > other.left &&
          b.top < other.bottom &&
          b.bottom > other.top
        )
          return other;
  };
  for (const card of cards)
    if (card.full)
      add({
        left: card.x - 110 * card.scale - 3,
        right: card.x + 110 * card.scale + 3,
        top: card.y - 132 * card.scale - 3,
        bottom: card.y + 132 * card.scale + 3,
      });
  for (const card of cards) {
    result.set(card.id, { x: 0, y: 0 });
    if (
      card.full ||
      card.x < 0 ||
      card.x > width ||
      card.y < 0 ||
      card.y > height
    )
      continue;
    const radius = 30 * card.scale + 3;
    const box = (p: { x: number; y: number }): Box => ({
      left: p.x - radius,
      right: p.x + radius,
      top: p.y - radius,
      bottom: p.y + radius,
    });
    const clamp = (p: { x: number; y: number }) => ({
      x: Math.max(radius, Math.min(width - radius, p.x)),
      y: Math.max(radius, Math.min(height - radius, p.y)),
    });
    const queue = [clamp(card)],
      visited = new Set<string>();
    let chosen = { x: card.x, y: card.y };
    // Nearest obstacle edges give continuous positions instead of snapping to a grid.
    for (let attempt = 0; queue.length && attempt < 64; attempt++) {
      queue.sort(
        (a, b) =>
          Math.hypot(a.x - card.x, a.y - card.y) -
          Math.hypot(b.x - card.x, b.y - card.y),
      );
      const p = queue.shift()!,
        key = `${p.x.toFixed(1)}:${p.y.toFixed(1)}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const other = collision(box(p));
      if (!other) {
        chosen = p;
        break;
      }
      queue.push(
        ...[
          { x: other.left - radius, y: p.y },
          { x: other.right + radius, y: p.y },
          { x: p.x, y: other.top - radius },
          { x: p.x, y: other.bottom + radius },
        ].map(clamp),
      );
    }
    result.set(card.id, { x: chosen.x - card.x, y: chosen.y - card.y });
    add(box(chosen));
  }
  return result;
}
