import type { LayoutWorkerRequest } from "./layout-worker-protocol.ts";

type Input = Pick<LayoutWorkerRequest, "people" | "links" | "mode" | "reverse">;
type Key = { version: number; width: number; height: number; input: Input };

/** History is only a solver hint. The current authorized projection remains authoritative. */
export function compatibleLayoutHistory(currentKey: string, previousKey: string): Input | undefined {
  try {
    const current: Key = JSON.parse(currentKey), previous: Key = JSON.parse(previousKey);
    const a = current.input, b = previous.input;
    if (current.version !== previous.version || current.width !== previous.width ||
        current.height !== previous.height || a.mode !== "generations" || b.mode !== a.mode ||
        a.reverse !== b.reverse || a.people.length > 4000 || b.people.length > 4000) return;
    const before = new Map(b.people.map(p => [p.id, JSON.stringify(p)]));
    let changes = 0;
    for (const person of a.people) {
      if (before.get(person.id) !== JSON.stringify(person)) changes++;
      before.delete(person.id);
    }
    if (changes + before.size > 4) return;
    const oldLinks = new Set(b.links.map(link => JSON.stringify(link)));
    let changedLinks = 0;
    for (const link of a.links) {
      const key = JSON.stringify(link);
      if (!oldLinks.delete(key)) changedLinks++;
    }
    if (changedLinks + oldLinks.size > 8) return;
    return b;
  } catch {
    return;
  }
}
