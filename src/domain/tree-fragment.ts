import type { familyNeighbors } from "./family-neighborhood.ts";
import { generationScope } from "./tree-generation-scope.ts";
import type { TreeGenerationLimits } from "./tree-preferences.ts";

export const DEFAULT_FRAGMENT_THRESHOLD = 500;
/** People sent to one fragment layout; independent of the activation threshold. */
export const FRAGMENT_PEOPLE_LIMIT = 500;
export const FRAGMENT_THRESHOLDS = [
  100, 250, 500, 1000, 2000, 5000, 0,
] as const;
export function isFragmentThreshold(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value === 0 || (Number(value) >= 100 && Number(value) <= 10000))
  );
}

type Index = ReturnType<typeof familyNeighbors>;
export type FragmentContinuation = {
  id: string;
  parents: string[];
  children: string[];
  partners: string[];
  other: string[];
};

/** Page through a wide boundary without repeatedly returning to the same people. */
export function fragmentContinuationWindow(
  continuation: FragmentContinuation,
  visible: ReadonlySet<string>,
  visited: ReadonlySet<string>,
) {
  const seen = new Set([...visited, ...visible]);
  const neighbors = [
    ...continuation.parents,
    ...continuation.children,
    ...continuation.partners,
    ...continuation.other,
  ];
  return {
    visited: seen,
    priority: [
      ...neighbors.filter((id) => !seen.has(id)),
      ...neighbors.filter((id) => seen.has(id)),
    ],
  };
}

/** Work only with an already authorized, explicitly filtered graph. Counts never
 * refer to the original archive or to paths through people outside `allowed`. */
export function treeFragment(
  index: Index,
  allowed: ReadonlySet<string>,
  limits: TreeGenerationLimits,
  expanded: ReadonlySet<string> = new Set(),
  budget = FRAGMENT_PEOPLE_LIMIT,
  priority: readonly string[] = [],
) {
  const visible = new Set<string>();
  const queue: string[] = [];
  const maximum = Math.min(
    FRAGMENT_PEOPLE_LIMIT,
    Math.max(1, Math.floor(budget) || 1),
  );
  const add = (id: string) => {
    if (
      !allowed.has(id) ||
      !index.people.has(id) ||
      visible.has(id) ||
      visible.size >= maximum
    )
      return;
    visible.add(id);
    queue.push(id);
  };
  const scoped = generationScope(index, limits);
  add(limits.anchorId);
  // A full fragment can replace its window with the requested boundary's
  // omitted neighbors. Keep the owner and only real, authorized one-edge paths.
  for (const id of priority)
    if (index.neighbors.get(limits.anchorId)?.has(id)) add(id);
  // A deleted anchor uses a real available person, never an empty scene.
  if (!queue.length) {
    const first = allowed.values().next().value;
    if (first) add(first);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const next of index.neighbors.get(id) || [])
      if (scoped.has(next)) add(next);
  }
  // Expansion retains the initial fragment and appends only requested branches.
  // Replaying from the root drops expansions disconnected by a collapse.
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (expanded.has(id))
      for (const next of index.neighbors.get(id) || []) add(next);
  }
  const continuations = new Map<string, FragmentContinuation>();
  const hidden = new Map<string, number>();
  for (const id of visible) {
    const person = index.people.get(id)!;
    const item: FragmentContinuation = {
      id,
      parents: [],
      children: [],
      partners: [],
      other: [],
    };
    for (const next of index.neighbors.get(id) || []) {
      if (visible.has(next) || !allowed.has(next)) continue;
      if (person.parents.includes(next)) item.parents.push(next);
      else if (index.children.get(id)?.has(next)) item.children.push(next);
      else if (
        person.spouses.includes(next) ||
        index.people.get(next)?.spouses.includes(id)
      )
        item.partners.push(next);
      else item.other.push(next);
    }
    const count =
      item.parents.length +
      item.children.length +
      item.partners.length +
      item.other.length;
    if (count) {
      continuations.set(id, item);
      hidden.set(id, count);
    }
  }
  return { visible, hidden, continuations, atLimit: visible.size >= maximum };
}
