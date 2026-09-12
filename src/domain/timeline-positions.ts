import {
  TREE_NODE_WIDTH as W,
  TREE_NODE_HEIGHT as H,
} from "./tree-layout-constants.ts";
import type { Point } from "./layout-order.ts";
import { Spatial, type Box } from "./edge-routing.ts";
import type { UnionBranch } from "./union-layout.ts";

export type TimelineCard = Point & { id: string; block: string };

/** Небольшой сдвиг семьи к её настоящим родителям и детям; пары остаются жёсткими. */
export function relaxTimelineCards(
  cards: TimelineCard[],
  branches: UnionBranch[],
) {
  const byId = new Map(cards.map((p) => [p.id, p]));
  const members = new Map<string, TimelineCard[]>();
  for (const p of cards) {
    const list = members.get(p.block) || [];
    list.push(p);
    members.set(p.block, list);
  }
  const centers = new Map(
    [...members].map(([id, ps]) => [
      id,
      ps.reduce((sum, p) => sum + p.x + W / 2, 0) / ps.length,
    ]),
  );
  const offsets = new Map<string, number[]>();
  const add = (id: string, value: number) => {
    const list = offsets.get(id) || [];
    list.push(value);
    offsets.set(id, list);
  };
  for (const b of branches) {
    if (!b.id.startsWith("child:")) continue;
    const parent = byId.get(b.source),
      child = byId.get(b.target);
    if (!parent || !child || parent.block === child.block) continue;
    const delta = child.x + W / 2 - centers.get(parent.block)!;
    add(parent.block, delta);
    add(child.block, -delta);
  }
  const shifts = new Map(
    [...offsets].map(([id, values]) => [
      id,
      Math.max(
        -360,
        Math.min(360, values.reduce((a, b) => a + b, 0) / values.length),
      ) * 0.65,
    ]),
  );
  return cards.map((p) => ({
    ...p,
    x: Math.round((p.x + (shifts.get(p.block) || 0)) * 10) / 10,
  }));
}

/** Двигаем союз целиком по X; годы всех его участников остаются неизменными. */
export function timelinePositions(cards: TimelineCard[]): [string, Point][] {
  const groups = new Map<string, TimelineCard[]>();
  for (const card of cards) {
    const group = groups.get(card.block) || [];
    group.push(card);
    groups.set(card.block, group);
  }
  const units = [...groups]
    .map(([id, members]) => ({
      id,
      members,
      x: Math.min(...members.map((p) => p.x)),
      y: Math.min(...members.map((p) => p.y)),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const occupied = new Spatial<Box>();
  const positions: [string, Point][] = [];
  let minX = Infinity,
    maxX = -Infinity;
  for (const unit of units) {
    const boxes: Box[] = unit.members.map((p) => ({
      left: p.x,
      right: p.x + W,
      top: p.y,
      bottom: p.y + H,
    }));
    if (unit.members.length === 2) {
      const [a, b] = [...unit.members].sort((a, b) => a.x - b.x);
      boxes.push({
        left: a.x + W + 10,
        right: b.x - 10,
        top: Math.min(a.y, b.y) + H / 2,
        bottom: Math.max(a.y, b.y) + H / 2,
      });
    }
    const intervals: [number, number][] = [];
    for (const box of boxes) {
      if (!Number.isFinite(minX)) continue;
      for (const other of occupied.query({
        left: minX,
        right: maxX,
        top: box.top - 20,
        bottom: box.bottom + 20,
      }))
        if (box.top < other.bottom + 20 && box.bottom > other.top - 20)
          intervals.push([
            other.left - box.right - 32,
            other.right - box.left + 32,
          ]);
    }
    const merged: [number, number][] = [];
    for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && interval[0] < last[1])
        last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const blocked = merged.find(([a, b]) => a < 0 && b > 0);
    const shift = blocked
      ? Math.abs(blocked[0]) < Math.abs(blocked[1])
        ? blocked[0]
        : blocked[1]
      : 0;
    for (const p of unit.members)
      positions.push([p.id, { x: p.x + shift, y: p.y }]);
    for (const box of boxes) {
      const placed = {
        ...box,
        left: box.left + shift,
        right: box.right + shift,
      };
      occupied.add(placed);
      minX = Math.min(minX, placed.left);
      maxX = Math.max(maxX, placed.right);
    }
  }
  return positions;
}
