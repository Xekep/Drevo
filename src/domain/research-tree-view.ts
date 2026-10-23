import type { Family, Person } from "./types.ts";

export type AssistantTreeFilter = (
  | { ids: string[] }
  | { excludeNeedsReview: true }
  | { excludeIds: string[] }
) & { excludeIds?: string[]; excludeNeedsReview?: true; preserveView?: true; viewToken?: number; label: string; token: number };

/** Explicit selections replace the view; exclusions only narrow its current scope. */
export function assistantProjectionPeople(allowed: ReadonlySet<string>, filter?: AssistantTreeFilter | null) {
  return filter && "ids" in filter ? new Set(filter.ids.filter(id => allowed.has(id))) : allowed;
}

/** A directed recorded branch in the already-authorized archive; never a surname. */
export function researchBranchPeople(family: Family, personId: unknown, direction: unknown) {
  const people = new Map(family.people.map(person => [person.id, person]));
  if (typeof personId !== "string" || !people.has(personId))
    throw new Error("Человек не найден или недоступен");
  if (direction !== "ancestors" && direction !== "descendants" && direction !== "self")
    throw new Error("Укажите ancestors, descendants или self");
  const children = new Map<string, string[]>();
  if (direction === "descendants") for (const person of family.people)
    for (const parent of person.parents) {
      const list = children.get(parent) || [];
      list.push(person.id);
      children.set(parent, list);
    }
  const seen = new Set([personId]);
  const queue = [personId];
  for (let index = 0; index < queue.length; index++) {
    const neighbors = direction === "ancestors" ? people.get(queue[index])!.parents
      : direction === "descendants" ? children.get(queue[index]) || [] : [];
    for (const id of neighbors) if (people.has(id) && !seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  return queue;
}

export function assistantVisiblePeople(
  people: readonly Person[], allowed: ReadonlySet<string>, filter?: AssistantTreeFilter | null,
) {
  if (!filter) return allowed;
  const visible = new Set(assistantProjectionPeople(allowed, filter));
  if ("excludeNeedsReview" in filter)
    for (const person of people) if (person.needsReview) visible.delete(person.id);
  for (const id of filter.excludeIds || []) visible.delete(id);
  return visible;
}

export function excludeAssistantPeople(
  current: AssistantTreeFilter | null, ids: string[], label: string, token: number,
): AssistantTreeFilter {
  return { ...current, excludeIds: [...new Set([...(current?.excludeIds || []), ...ids])],
    preserveView: true, viewToken: current?.viewToken ?? (current?.preserveView ? undefined : current?.token), label, token };
}

export function hideReviewAssistantPeople(
  current: AssistantTreeFilter | null, token: number,
): AssistantTreeFilter {
  return { ...current, excludeNeedsReview: true, preserveView: true,
    viewToken: current?.viewToken ?? (current?.preserveView ? undefined : current?.token),
    label: "Без карточек на проверке", token };
}
