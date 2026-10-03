import { fullName } from "./dates.ts";
import { validateFamily } from "./validation.ts";
import type { Family } from "./types.ts";

export type ImportBatch = {
  revision: number;
  at: string;
  actorName: string;
  count: number;
  undone: boolean;
};
export type ImportUndoPreview = {
  revision: number;
  fingerprint: string;
  importRevision: number;
  importedCount: number;
  alreadyRemoved: number;
  editedCount: number;
  people: { id: string; name: string }[];
  connections: number;
  photoTags: number;
  errors: string[];
  errorCount: number;
};

/** IDs come from server audit, never from a client file or a guessed branch. */
export function removeImportedPeople(current: Family, ids: Set<string>) {
  const people = current.people.filter((p) => ids.has(p.id));
  const retained = current.people.filter((p) => !ids.has(p.id));
  const errors: string[] = [];
  for (const p of retained)
    if ([...p.parents, ...p.spouses].some((id) => ids.has(id)))
      errors.push(
        `${fullName(p)}: появилась связь с импортированным человеком. Сначала разберите её в карточке — оставшийся человек не будет изменён.`,
      );
  for (const link of current.links || [])
    if (ids.has(link.from) !== ids.has(link.to))
      errors.push(
        "Есть дополнительная связь с человеком вне импорта. Сначала удалите или измените эту связь.",
      );
  for (const union of current.unions || [])
    if (
      union.participants.some((id) => ids.has(id)) &&
      union.participants.some((id) => !ids.has(id))
    )
      errors.push(
        "Есть семейный союз с человеком вне импорта. Сначала разберите этот союз — оставшийся человек не будет изменён.",
      );
  const photoTags = (current.photos || []).reduce(
    (n, p) => n + p.tags.filter((t) => ids.has(t.personId)).length,
    0,
  );
  const connections =
    people.reduce((n, p) => n + p.parents.length + p.spouses.length / 2, 0) +
    (current.links || []).filter((l) => ids.has(l.from) || ids.has(l.to))
      .length +
    (current.unions || []).filter((union) =>
      union.participants.some((id) => ids.has(id)),
    ).length;
  const family = errors.length
    ? current
    : validateFamily({
        ...current,
        people: retained,
        ...(current.unions
          ? {
              unions: current.unions.filter((union) =>
                union.participants.every((id) => !ids.has(id)),
              ),
            }
          : {}),
        ...(current.links
          ? {
              links: current.links.filter(
                (l) => !ids.has(l.from) && !ids.has(l.to),
              ),
            }
          : {}),
        ...(current.photos
          ? {
              photos: current.photos.map((p) => ({
                ...p,
                tags: p.tags.filter((t) => !ids.has(t.personId)),
              })),
            }
          : {}),
      });
  return {
    family,
    people: people.map((p) => ({ id: p.id, name: fullName(p) })),
    connections,
    photoTags,
    errors,
  };
}
