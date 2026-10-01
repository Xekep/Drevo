import type { CSSProperties } from "react";
import {
  generationLevels,
  type LayoutPerson,
} from "../../domain/tree-layout.ts";

export const TREE_GROWTH_EDGE_MS = 240;
export const TREE_GROWTH_NODE_MS = 280;
export const TREE_GROWTH_REVEAL_MS = 100;
const TREE_GROWTH_LABEL_MS = 160;
export const TREE_GROWTH_ORDER_MS = 30;
export const TREE_GROWTH_MAX_ORDER_MS = 200;
export const TREE_LAYOUT_TRANSITION_MS = 440;

/** Large archives finish their introduction sooner, including cards and labels. */
export function treeGrowthBudget(personCount: number) {
  return Math.max(600, 4_000 * Math.sqrt(25 / Math.max(25, personCount)));
}

type GrowthStyle = CSSProperties & {
  "--tree-growth-delay": string;
  "--tree-edge-label-delay"?: string;
  "--tree-growth-edge-duration"?: string;
};
type GrowthCanvasStyle = CSSProperties & {
  "--tree-growth-label-duration": string;
  "--tree-growth-node-duration": string;
  "--tree-growth-reveal-duration": string;
  "--tree-growth-edge-duration": string;
};
export type TreeGrowthSchedule = ReadonlyMap<string, number> & {
  readonly labelMs: number;
  readonly nodeMs: number;
  readonly revealMs: number;
  readonly edgeMs: number;
  readonly parentEdgeStarts: ReadonlyMap<string, number>;
};

function birthOrder(a: LayoutPerson, b: LayoutPerson) {
  return (
    (a.birth || "9999-99-99").localeCompare(b.birth || "9999-99-99") ||
    a.id.localeCompare(b.id)
  );
}

function spouseGroups(
  members: LayoutPerson[],
  partners: ReadonlyMap<string, ReadonlySet<string>>,
) {
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
    .map((group) => {
      const sorted = group.sort(birthOrder);
      const byId = new Map(sorted.map((person) => [person.id, person]));
      const visited = new Set([sorted[0].id]);
      const ordered = [sorted[0]];
      for (let index = 0; index < ordered.length; index++) {
        const next = [...(partners.get(ordered[index].id) || [])]
          .flatMap((id) =>
            byId.has(id) && !visited.has(id) ? [byId.get(id)!] : [],
          )
          .sort(birthOrder);
        for (const person of next) {
          visited.add(person.id);
          ordered.push(person);
        }
      }
      return ordered;
    })
    .sort((left, right) => birthOrder(left[0], right[0]));
}

function timing(delays: ReadonlyMap<string, number>) {
  const schedule = delays as Partial<TreeGrowthSchedule>;
  return {
    labelMs: schedule.labelMs ?? TREE_GROWTH_LABEL_MS,
    nodeMs: schedule.nodeMs ?? TREE_GROWTH_NODE_MS,
    revealMs: schedule.revealMs ?? TREE_GROWTH_REVEAL_MS,
    edgeMs: schedule.edgeMs ?? TREE_GROWTH_EDGE_MS,
  };
}

function milliseconds(value: number) {
  return `${Math.round(Math.max(0, value) * 1_000) / 1_000}ms`;
}

/**
 * Поколения появляются волнами, а люди внутри поколения — по дате рождения.
 * Следующее поколение ждёт появления всех карточек предыдущего. Затем
 * одновременно начинают рисоваться родительские линии. Каждая доходит до
 * потомка ровно к появлению его карточки, без ожидания после конца линии.
 * Новый супруг появляется после соединяющей его линии. Декоративное
 * движение карточки продолжается во время роста исходящих линий.
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

  const rawDelays = new Map<string, number>();
  const rawParentEdgeStarts = new Map<string, number>();
  const partners = new Map(
    people.map((person) => [person.id, new Set<string>()]),
  );
  for (const person of people)
    for (const spouse of person.spouses) {
      if (!partners.has(spouse)) continue;
      partners.get(person.id)!.add(spouse);
      partners.get(spouse)!.add(person.id);
    }
  let levelEnd = 0;
  let firstLevel = true;
  for (const level of [...generations.keys()].sort((a, b) => a - b)) {
    const members = generations.get(level)!;
    const edgeStart = levelEnd;
    const nodeStart = firstLevel ? 0 : edgeStart + TREE_GROWTH_EDGE_MS;
    firstLevel = false;
    const step =
      members.length > 1
        ? Math.min(
            TREE_GROWTH_ORDER_MS,
            TREE_GROWTH_MAX_ORDER_MS / (members.length - 1),
          )
        : 0;
    let orderOffset = 0;
    let generationEnd = nodeStart;
    for (const group of spouseGroups(members, partners)) {
      let groupEnd = nodeStart + orderOffset;
      group.forEach((person, index) => {
        const spouseReady = [...partners.get(person.id)!].flatMap((id) => {
          const delay = rawDelays.get(id);
          return delay === undefined
            ? []
            : [delay + TREE_GROWTH_REVEAL_MS + TREE_GROWTH_EDGE_MS];
        });
        const delay = Math.max(
          nodeStart + orderOffset + index * step,
          ...spouseReady,
        );
        rawDelays.set(person.id, delay);
        groupEnd = Math.max(groupEnd, delay);
        if (nodeStart) rawParentEdgeStarts.set(person.id, edgeStart);
      });
      generationEnd = Math.max(generationEnd, groupEnd);
      orderOffset = groupEnd - nodeStart + step;
    }
    levelEnd = generationEnd + TREE_GROWTH_REVEAL_MS;
  }
  const last = Math.max(0, ...rawDelays.values());
  const tail = Math.max(
    TREE_GROWTH_NODE_MS,
    TREE_GROWTH_REVEAL_MS + TREE_GROWTH_EDGE_MS + TREE_GROWTH_LABEL_MS,
  );
  const scale = Math.min(1, treeGrowthBudget(people.length) / (last + tail));
  return Object.assign(
    new Map([...rawDelays].map(([id, delay]) => [id, delay * scale])),
    {
      labelMs: TREE_GROWTH_LABEL_MS * scale,
      nodeMs: TREE_GROWTH_NODE_MS * scale,
      revealMs: TREE_GROWTH_REVEAL_MS * scale,
      edgeMs: TREE_GROWTH_EDGE_MS * scale,
      parentEdgeStarts: new Map(
        [...rawParentEdgeStarts].map(([id, delay]) => [id, delay * scale]),
      ),
    },
  );
}

export function treeNodeGrowthStyle(delay: number): GrowthStyle {
  return { "--tree-growth-delay": milliseconds(delay) };
}

export function treeGrowthCanvasStyle(
  delays: ReadonlyMap<string, number>,
): GrowthCanvasStyle {
  const { nodeMs, revealMs, edgeMs, labelMs } = timing(delays);
  return {
    "--tree-growth-label-duration": milliseconds(labelMs),
    "--tree-growth-node-duration": milliseconds(nodeMs),
    "--tree-growth-reveal-duration": milliseconds(revealMs),
    "--tree-growth-edge-duration": milliseconds(edgeMs),
  };
}

export function treeEdgeGrowthStyle(
  delay: number,
  labelDelay: number,
  duration?: number,
): GrowthStyle {
  return {
    "--tree-growth-delay": milliseconds(delay),
    "--tree-edge-label-delay": milliseconds(labelDelay),
    ...(duration === undefined
      ? {}
      : { "--tree-growth-edge-duration": milliseconds(duration) }),
  };
}

export function treeConnectionGrowthStyle(
  connection: { from: string; to: string; type: string },
  delays: ReadonlyMap<string, number>,
) {
  const from = delays.get(connection.from) || 0;
  const to = delays.get(connection.to) || 0;
  const { revealMs, edgeMs } = timing(delays);
  if (connection.type === "parent") {
    const scheduled = (
      delays as Partial<TreeGrowthSchedule>
    ).parentEdgeStarts?.get(connection.to);
    const line = Math.max(from + revealMs, scheduled ?? to - edgeMs);
    // Birth order staggers cards within a generation. Keep the line moving
    // through that stagger instead of ending every line before the first card.
    const duration = Math.max(edgeMs, to - line);
    return treeEdgeGrowthStyle(line, line + duration, duration);
  }
  if (connection.type === "spouse") {
    const line = Math.min(from, to) + revealMs;
    const duration = Math.max(edgeMs, Math.max(from, to) - line);
    return treeEdgeGrowthStyle(line, line + duration, duration);
  }
  const line = Math.max(from, to) + revealMs;
  return treeEdgeGrowthStyle(line, line + edgeMs);
}

export function treeGrowthDuration(
  maxDelay: number,
  delays?: ReadonlyMap<string, number>,
) {
  const { nodeMs, revealMs, edgeMs, labelMs } = timing(delays || new Map());
  return maxDelay + Math.max(nodeMs, revealMs + edgeMs + labelMs);
}
