import type { ElkNode } from "elkjs";
import { TREE_NODE_WIDTH as W, TREE_NODE_HEIGHT as H } from "./tree-layout.ts";

type Unit = { id: string; members: string[]; children: string[] };
type Attachment = { from: Unit; to: Unit; child: string };
export type LeafGroup = {
  width: number;
  height: number;
  inset: number;
  leaves: { unit: string; person: string; x: number; y: number }[];
};
/** Терминальные дети остаются рядом со своей точной родительской семьёй. */
export function familyLeafGroups(
  units: Unit[],
  attachments: Attachment[],
  protectedPeople: Set<string>,
  births: ReadonlyMap<string, string> = new Map(),
) {
  const candidates = new Map<string, Attachment[]>();
  const parents = new Set(attachments.map((a) => a.from.id));
  for (const a of attachments) {
    if (
      a.to.members.length !== 1 ||
      parents.has(a.to.id) ||
      !a.to.id.startsWith("person:") ||
      protectedPeople.has(a.child)
    )
      continue;
    const list = candidates.get(a.from.id) || [];
    list.push(a);
    candidates.set(a.from.id, list);
  }
  const groups = new Map<string, LeafGroup>();
  const folded = new Set<string>();
  for (const u of units) {
    const children = candidates.get(u.id) || [];
    if (children.length < 2) continue;
    children.sort(
      (a, b) =>
        (births.get(a.child) || "9999").localeCompare(
          births.get(b.child) || "9999",
        ) || a.child.localeCompare(b.child),
    );
    const columns = Math.min(3, children.length),
      rows = Math.ceil(children.length / columns);
    const parentWidth = u.members.length * (W + 32) - 32;
    const width = Math.max(parentWidth, columns * (W + 32) - 32) + 64;
    const leaves = children.map((a, i) => {
      folded.add(a.to.id);
      const row = Math.floor(i / columns),
        size = Math.min(columns, children.length - row * columns);
      return {
        unit: a.to.id,
        person: a.child,
        x: (width - (size * (W + 32) - 32)) / 2 + (i % columns) * (W + 32),
        y: H + 72 + row * (H + 64),
      };
    });
    groups.set(u.id, {
      width,
      height: H + 72 + rows * (H + 64) - 64 + 24,
      inset: (width - parentWidth) / 2,
      leaves,
    });
  }
  return { groups, folded };
}

/** Альтернативы сравниваются только у чрезмерно широкого дерева. */
export async function compactFamilyLayout(
  graph: ElkNode,
  layout: (graph: ElkNode) => Promise<ElkNode>,
) {
  const baseline = await layout(structuredClone(graph));
  const bounds = (g: ElkNode) => {
    const nodes = g.children || [];
    if (!nodes.length) return { width: 0, height: 0 };
    return {
      width:
        Math.max(...nodes.map((n) => (n.x || 0) + (n.width || 0))) -
        Math.min(...nodes.map((n) => n.x || 0)),
      height:
        Math.max(...nodes.map((n) => (n.y || 0) + (n.height || 0))) -
        Math.min(...nodes.map((n) => n.y || 0)),
    };
  };
  const before = bounds(baseline);
  if (before.width < 2200 || before.width < before.height * 1.8)
    return baseline;
  let best = baseline,
    score = Math.max(before.width, before.height);
  for (const bound of [4, 2]) {
    try {
      const compact = await layout({
        ...structuredClone(graph),
        layoutOptions: {
          ...graph.layoutOptions,
          "elk.layered.layering.strategy": "MIN_WIDTH",
          "elk.layered.layering.minWidth.upperBoundOnWidth": String(bound),
        },
      });
      if (
        compact.children?.length !== baseline.children?.length ||
        compact.edges?.length !== baseline.edges?.length ||
        !compact.children?.every(
          (n) => Number.isFinite(n.x) && Number.isFinite(n.y),
        )
      )
        continue;
      const after = bounds(compact),
        candidate = Math.max(after.width, after.height);
      if (
        after.width < before.width * 0.9 &&
        candidate < Math.max(before.width, before.height) * 0.88 &&
        candidate < score
      ) {
        best = compact;
        score = candidate;
      }
    } catch {
      // Ошибка необязательной оптимизации не скрывает уже рассчитанное дерево.
    }
  }
  return best;
}
