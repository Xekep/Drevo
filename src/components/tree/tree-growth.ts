import type { CSSProperties } from "react";
import {
  generationLevels,
  type LayoutPerson,
} from "../../domain/tree-layout.ts";

export const TREE_GROWTH_EDGE_MS = 300;
export const TREE_GROWTH_NODE_MS = 340;
export const TREE_GROWTH_ORDER_MS = 45;
export const TREE_GROWTH_MAX_ORDER_MS = 360;
export const TREE_GROWTH_MAX_DELAY_MS = 3_500;
export const TREE_LAYOUT_TRANSITION_MS = 440;

type GrowthStyle = CSSProperties & {
  "--tree-growth-delay": string;
  "--tree-edge-label-delay"?: string;
};

function birthOrder(a: LayoutPerson, b: LayoutPerson) {
  return (
    (a.birth || "9999-99-99").localeCompare(b.birth || "9999-99-99") ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Поколения появляются волнами, а люди внутри поколения — по дате рождения.
 * Следующая волна начинается только после появления всего предыдущего
 * поколения: супруг без записанных родителей не опережает общих потомков.
 */
export function treeGrowthDelays(people: LayoutPerson[]) {
  const levels = generationLevels(people);
  const generations = new Map<number, LayoutPerson[]>();
  for (const person of people) {
    const level = levels.get(person.id) || 0;
    const group = generations.get(level) || [];
    group.push(person);
    generations.set(level, group);
  }

  const delays = new Map<string, number>();
  let waveStart = 0;
  for (const level of [...generations.keys()].sort((a, b) => a - b)) {
    const members = generations.get(level)!.sort(birthOrder);
    const step =
      members.length > 1
        ? Math.min(
            TREE_GROWTH_ORDER_MS,
            TREE_GROWTH_MAX_ORDER_MS / (members.length - 1),
          )
        : 0;
    let last = waveStart;
    members.forEach((person, index) => {
      const delay = Math.min(
        TREE_GROWTH_MAX_DELAY_MS,
        Math.round(waveStart + index * step),
      );
      delays.set(person.id, delay);
      last = Math.max(last, delay);
    });
    waveStart = Math.min(
      TREE_GROWTH_MAX_DELAY_MS,
      last + TREE_GROWTH_NODE_MS + TREE_GROWTH_EDGE_MS,
    );
  }
  return delays;
}

export function treeNodeGrowthStyle(delay: number): GrowthStyle {
  return { "--tree-growth-delay": `${Math.max(0, delay)}ms` };
}

export function treeEdgeGrowthStyle(
  delay: number,
  labelDelay = delay + TREE_GROWTH_EDGE_MS,
): GrowthStyle {
  return {
    "--tree-growth-delay": `${Math.max(0, delay)}ms`,
    "--tree-edge-label-delay": `${Math.max(0, labelDelay)}ms`,
  };
}

export function treeConnectionGrowthStyle(
  connection: { from: string; to: string; type: string },
  delays: ReadonlyMap<string, number>,
) {
  const from = delays.get(connection.from) || 0;
  const to = delays.get(connection.to) || 0;
  if (connection.type === "parent") {
    const line = Math.max(from + TREE_GROWTH_NODE_MS, to - TREE_GROWTH_EDGE_MS);
    return treeEdgeGrowthStyle(line, Math.max(to, line + TREE_GROWTH_EDGE_MS));
  }
  if (connection.type === "spouse") {
    const line = Math.max(from, to);
    return treeEdgeGrowthStyle(line);
  }
  const line = Math.max(from, to) + TREE_GROWTH_NODE_MS;
  return treeEdgeGrowthStyle(line);
}

export function treeGrowthDuration(maxDelay: number) {
  return maxDelay + TREE_GROWTH_NODE_MS + TREE_GROWTH_EDGE_MS + 200;
}
