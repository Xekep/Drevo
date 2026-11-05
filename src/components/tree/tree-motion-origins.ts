import type { GpuMotionPoint } from "./gpu-motion.ts";
import type { PersonNodeType } from "./person-node.tsx";

/** New relatives unfold from the nearest retained relative rather than fading
 * in at a distant final position. One breadth-first pass, only visible people. */
export function treeMotionOrigins(nodes: readonly PersonNodeType[], previous: ReadonlyMap<string, GpuMotionPoint>) {
  const neighbors = new Map<string, Set<string>>(), origins = new Map<string, GpuMotionPoint>();
  const queue: string[] = [];
  for (const node of nodes) neighbors.set(node.data.person.id, new Set());
  for (const node of nodes) {
    const person = node.data.person, adjacent = neighbors.get(person.id)!;
    for (const id of [...person.parents, ...person.spouses]) {
      if (!neighbors.has(id)) continue;
      adjacent.add(id);
      neighbors.get(id)!.add(person.id);
    }
    const old = previous.get(node.id);
    if (old && !origins.has(person.id)) {
      origins.set(person.id, old);
      queue.push(person.id);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const relative of neighbors.get(id)!) {
      if (origins.has(relative)) continue;
      origins.set(relative, origins.get(id)!);
      queue.push(relative);
    }
  }
  return new Map(nodes.flatMap(node => {
    const origin = origins.get(node.data.person.id);
    return !previous.has(node.id) && origin ? [[node.id, { ...origin, opacity: 0 }] as const] : [];
  }));
}
