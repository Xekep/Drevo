import type { CSSProperties } from "react";
import {
  generationLevels,
  type LayoutPerson,
} from "../../domain/tree-layout.ts";

export const TREE_GROWTH_EDGE_MS = 240;
export const TREE_GROWTH_NODE_MS = 280;
export const TREE_GROWTH_ORDER_MS = 30;
export const TREE_GROWTH_MAX_ORDER_MS = 200;
export const TREE_GROWTH_MAX_DELAY_MS = 3_500;
export const TREE_LAYOUT_TRANSITION_MS = 440;

type GrowthStyle = CSSProperties & {
  "--tree-growth-delay": string;
  "--tree-edge-label-delay"?: string;
};
type GrowthCanvasStyle = CSSProperties & {
  "--tree-growth-node-duration": string;
  "--tree-growth-edge-duration": string;
};
export type TreeGrowthSchedule = ReadonlyMap<string, number> & {
  readonly nodeMs: number;
  readonly edgeMs: number;
};

function birthOrder(a: LayoutPerson, b: LayoutPerson) {
  return (
    (a.birth || "9999-99-99").localeCompare(b.birth || "9999-99-99") ||
    a.id.localeCompare(b.id)
  );
}

function spouseGroups(members: LayoutPerson[]) {
  const owners = new Map(members.map((person) => [person.id, person.id]));
  const find = (id: string): string => {
    let root = id;
    while (owners.get(root) !== root) root = owners.get(root)!;
    while (owners.get(id) !== id) {
      const next = owners.get(id)!;
      owners.set(id, root);
      id = next;
    }
    return root;
  };
  for (const person of members)
    for (const spouse of person.spouses)
      if (owners.has(spouse)) owners.set(find(spouse), find(person.id));

  const groups = new Map<string, LayoutPerson[]>();
  for (const person of members) {
    const root = find(person.id);
    const group = groups.get(root) || [];
    group.push(person);
    groups.set(root, group);
  }
  return [...groups.values()]
    .map((group) => group.sort(birthOrder))
    .sort((left, right) => birthOrder(left[0], right[0]));
}

function timing(delays: ReadonlyMap<string, number>) {
  const schedule = delays as Partial<TreeGrowthSchedule>;
  return {
    nodeMs: schedule.nodeMs ?? TREE_GROWTH_NODE_MS,
    edgeMs: schedule.edgeMs ?? TREE_GROWTH_EDGE_MS,
  };
}

function milliseconds(value: number) {
  return `${Math.round(Math.max(0, value) * 1_000) / 1_000}ms`;
}

/**
 * Поколения появляются волнами, а люди внутри поколения — по дате рождения.
 * Каждая семейная ветвь продолжается сразу после появления её родителей и
 * отображаемых супругов. Независимые ветви не создают друг другу паузу.
 */
export function treeGrowthDelays(people: LayoutPerson[]): TreeGrowthSchedule {
  const levels = generationLevels(people);
  const generations = new Map<number, LayoutPerson[]>();
  for (const person of people) {
    const level = levels.get(person.id) || 0;
    const group = generations.get(level) || [];
    group.push(person);
    generations.set(level, group);
  }

  const peopleMap = new Map(people.map((person) => [person.id, person]));
  const rawDelays = new Map<string, number>();
  const householdEnds = new Map<string, number>();
  for (const level of [...generations.keys()].sort((a, b) => a - b)) {
    const members = generations.get(level)!;
    const step =
      members.length > 1
        ? Math.min(
            TREE_GROWTH_ORDER_MS,
            TREE_GROWTH_MAX_ORDER_MS / (members.length - 1),
          )
        : 0;
    let orderOffset = 0;
    for (const group of spouseGroups(members)) {
      let ready = 0;
      for (const person of group)
        for (const parent of person.parents) {
          if (!peopleMap.has(parent)) continue;
          const parentEnd = householdEnds.get(parent);
          if (parentEnd !== undefined)
            ready = Math.max(ready, parentEnd + TREE_GROWTH_EDGE_MS);
        }
      const start = ready + orderOffset;
      group.forEach((person, index) =>
        rawDelays.set(person.id, start + index * step),
      );
      const end = Math.max(
        ...group.map(
          (person) => rawDelays.get(person.id)! + TREE_GROWTH_NODE_MS,
        ),
      );
      for (const person of group) householdEnds.set(person.id, end);
      orderOffset += group.length * step;
    }
  }
  const last = Math.max(0, ...rawDelays.values());
  const scale =
    last > TREE_GROWTH_MAX_DELAY_MS ? TREE_GROWTH_MAX_DELAY_MS / last : 1;
  return Object.assign(
    new Map([...rawDelays].map(([id, delay]) => [id, delay * scale])),
    {
      nodeMs: TREE_GROWTH_NODE_MS * scale,
      edgeMs: TREE_GROWTH_EDGE_MS * scale,
    },
  );
}

export function treeNodeGrowthStyle(delay: number): GrowthStyle {
  return { "--tree-growth-delay": milliseconds(delay) };
}

export function treeGrowthCanvasStyle(
  delays: ReadonlyMap<string, number>,
): GrowthCanvasStyle {
  const { nodeMs, edgeMs } = timing(delays);
  return {
    "--tree-growth-node-duration": milliseconds(nodeMs),
    "--tree-growth-edge-duration": milliseconds(edgeMs),
  };
}

export function treeEdgeGrowthStyle(
  delay: number,
  labelDelay = delay + TREE_GROWTH_EDGE_MS,
): GrowthStyle {
  return {
    "--tree-growth-delay": milliseconds(delay),
    "--tree-edge-label-delay": milliseconds(labelDelay),
  };
}

export function treeConnectionGrowthStyle(
  connection: { from: string; to: string; type: string },
  delays: ReadonlyMap<string, number>,
) {
  const from = delays.get(connection.from) || 0;
  const to = delays.get(connection.to) || 0;
  const { nodeMs, edgeMs } = timing(delays);
  if (connection.type === "parent") {
    const line = Math.max(from + nodeMs, to - edgeMs);
    return treeEdgeGrowthStyle(line, Math.max(to, line + edgeMs));
  }
  if (connection.type === "spouse") {
    const line = Math.max(from, to);
    return treeEdgeGrowthStyle(line, line + edgeMs);
  }
  const line = Math.max(from, to) + nodeMs;
  return treeEdgeGrowthStyle(line, line + edgeMs);
}

export function treeGrowthDuration(
  maxDelay: number,
  delays?: ReadonlyMap<string, number>,
) {
  const { nodeMs, edgeMs } = timing(delays || new Map());
  return maxDelay + nodeMs + edgeMs + 200;
}
