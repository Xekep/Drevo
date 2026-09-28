import type { ElkNode } from "elkjs";
import type { TreeNodeSize } from "./tree-layout-constants.ts";

export const GENERATION_DEVIATION = 30;
export type GenerationBand = {
  level: number;
  targetY: number;
  minY: number;
  maxY: number;
  members: string[];
};

/** Сохраняем порядок и коридоры ELK, совмещая поколения независимых компонент. */
export function alignGenerationBands(input: ElkNode, size: TreeNodeSize) {
  const graph = structuredClone(input);
  const nodes = graph.children || [];
  const edges = graph.edges || [];
  const owners = new Map(nodes.map((n) => [n.id, n.id]));
  const ports = new Map(
    nodes.flatMap((n) => (n.ports || []).map((p) => [p.id, n.id])),
  );
  const find = (id: string): string => {
    let root = id;
    while (owners.get(root) !== root) root = owners.get(root)!;
    while (id !== root) {
      const next = owners.get(id)!;
      owners.set(id, root);
      id = next;
    }
    return root;
  };
  const incoming = new Map<string, number>(),
    outgoing = new Map<string, number>();
  for (const edge of edges) {
    const from = ports.get(edge.sources[0]) || edge.sources[0];
    const to = ports.get(edge.targets[0]) || edge.targets[0];
    owners.set(find(to), find(from));
    incoming.set(to, (incoming.get(to) || 0) + 1);
    outgoing.set(from, (outgoing.get(from) || 0) + 1);
  }
  const offsets = new Map(
    nodes.map((n) => {
      const above = incoming.get(n.id) || 0,
        below = outgoing.get(n.id) || 0;
      // Притяжение к связям с мягким штрафом за удаление от центра полосы.
      // Одинаковые семейные структуры остаются на общей линии; случайного jitter нет.
      return [
        n.id,
        Math.round(
          (GENERATION_DEVIATION * (below - above)) / (above + below + 2),
        ),
      ];
    }),
  );
  const level = (n: ElkNode) =>
    Number(n.layoutOptions!["elk.partitioning.partition"]);
  const groups = new Map<string, ElkNode[]>();
  for (const node of nodes) {
    const key = find(node.id),
      group = groups.get(key) || [];
    group.push(node);
    groups.set(key, group);
  }
  const componentEdges = new Map<string, typeof edges>();
  for (const edge of edges) {
    const key = find(ports.get(edge.sources[0]) || edge.sources[0]);
    const list = componentEdges.get(key) || [];
    list.push(edge);
    componentEdges.set(key, list);
  }
  const components = [...groups]
    .map(([id, members]) => {
      const rows = new Map<number, number>();
      for (const node of members) rows.set(level(node), node.y!);
      const routes = componentEdges.get(id) || [];
      const points = routes.flatMap((e) =>
        (e.sections || []).flatMap((s) => [
          s.startPoint,
          ...(s.bendPoints || []),
          s.endPoint,
        ]),
      );
      const ordered = [...rows].sort((a, b) => a[0] - b[0]);
      const corridors = ordered.slice(1).map(([to, end], i) => {
        const [from, y] = ordered[i];
        const start = y + size.height + 2 * GENERATION_DEVIATION;
        const lanes = [
          start,
          ...new Set(
            points.filter((p) => p.y > start && p.y < end).map((p) => p.y),
          ),
          end,
        ].sort((a, b) => a - b);
        // Монотонное преобразование сохраняет порядок всех линий и пересечений.
        // Пустые участки сокращаются; соседним каналам оставляем до 12 px.
        const distances = lanes
          .slice(1)
          .map((y, j) => Math.min(12, y - lanes[j]));
        const length = distances.reduce((sum, d) => sum + d, 0);
        return {
          from,
          to,
          lanes,
          distances,
          length,
          gap: Math.max(36, length),
        };
      });
      return {
        id,
        members,
        points,
        corridors,
        rows: ordered,
      };
    })
    .sort((a, b) => a.rows[0][0] - b.rows[0][0] || a.id.localeCompare(b.id));

  const layers = new Map<number, ElkNode[]>();
  for (const node of nodes) {
    const rank = level(node),
      row = layers.get(rank) || [];
    row.push(node);
    layers.set(rank, row);
  }
  // Сколько места действительно нужно маршрутам между соседними полосами.
  const constraints = new Map<number, { from: number; distance: number }[]>();
  for (const component of components)
    for (const { from, to, gap } of component.corridors) {
      const list = constraints.get(to) || [];
      list.push({
        from,
        distance: size.height + 2 * GENERATION_DEVIATION + gap,
      });
      constraints.set(to, list);
    }
  const bands: GenerationBand[] = [];
  const targets = new Map<number, number>();
  const pitch = Math.max(180, size.height + 96);
  let previousMaxOffset = 0;
  for (const [rank, members] of [...layers].sort((a, b) => a[0] - b[0])) {
    const previous = bands.at(-1);
    const minOffset = Math.min(...members.map((n) => offsets.get(n.id)!));
    let targetY = previous
      ? previous.targetY +
        Math.max(
          (rank - previous.level) * pitch,
          Math.max(150, size.height + 60) + previousMaxOffset - minOffset,
        )
      : 12 + GENERATION_DEVIATION;
    for (const constraint of constraints.get(rank) || [])
      targetY = Math.max(
        targetY,
        targets.get(constraint.from)! + constraint.distance,
      );
    targets.set(rank, targetY);
    bands.push({
      level: rank,
      targetY,
      minY: targetY - GENERATION_DEVIATION,
      maxY: targetY + GENERATION_DEVIATION,
      members: members.map((n) => n.id),
    });
    previousMaxOffset = Math.max(...members.map((n) => offsets.get(n.id)!));
  }

  const rightByLevel = new Map<number, number>();
  for (const component of components) {
    const { points } = component;
    const left = Math.min(
      ...component.members.map((n) => n.x!),
      ...points.map((p) => p.x),
    );
    const right = Math.max(
      ...component.members.map((n) => n.x! + n.width!),
      ...points.map((p) => p.x),
    );
    const first = component.rows[0][0],
      last = component.rows.at(-1)![0];
    let x = 12;
    // Компоненты с непересекающимися поколениями могут использовать тот же X.
    // Это также сохраняет ограниченные части очень длинных цепочек ELK.
    for (let rank = first; rank <= last; rank++)
      x = Math.max(x, (rightByLevel.get(rank) ?? -88) + 100);
    for (let rank = first; rank <= last; rank++)
      rightByLevel.set(rank, x + right - left);
    const knots = component.rows.flatMap(([rank, oldY]) => {
      const newY = targets.get(rank)! - GENERATION_DEVIATION;
      const height = size.height + 2 * GENERATION_DEVIATION;
      return [
        { from: oldY, to: newY },
        { from: oldY + height, to: newY + height },
      ];
    });
    for (const corridor of component.corridors) {
      const start =
        targets.get(corridor.from)! + size.height + GENERATION_DEVIATION;
      const gap = targets.get(corridor.to)! - GENERATION_DEVIATION - start;
      let walked = 0;
      for (let i = 1; i < corridor.lanes.length - 1; i++) {
        walked += corridor.distances[i - 1];
        knots.push({
          from: corridor.lanes[i],
          to: start + (gap * walked) / corridor.length,
        });
      }
    }
    knots.sort((a, b) => a.from - b.from);
    const mapY = (y: number) => {
      let lo = 0,
        hi = knots.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (knots[mid].from <= y) lo = mid;
        else hi = mid - 1;
      }
      const a = knots[lo],
        b = knots[lo + 1];
      if (!b || y < a.from) return a.to + y - a.from;
      return a.to + ((y - a.from) * (b.to - a.to)) / (b.from - a.from);
    };
    for (const node of component.members) {
      node.x = node.x! + x - left;
      node.y = mapY(node.y!);
    }
    // Один и тот же объект точки может принадлежать нескольким sections.
    for (const point of new Set(points)) {
      point.x += x - left;
      point.y = mapY(point.y);
    }
  }
  return { graph, bands, offsets };
}
