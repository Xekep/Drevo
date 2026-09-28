import type { TreeGeometry } from "../../domain/tree-layout.ts";

/** Находим карточки именно выбранной семейной группы, а не другие копии тех же людей. */
export function familySpotlight(
  geometry: TreeGeometry,
  groupId: string,
  memberIds: readonly string[],
) {
  const union = `union:${groupId}`;
  const members = new Set(memberIds);
  const occurrences = geometry.occurrences || [];
  const peopleByOccurrence = new Map(
    occurrences.map(({ id, personId }) => [id, personId]),
  );
  const available = new Set(geometry.positions.map(([id]) => id));
  const chosen = new Map<string, string>();

  for (const occurrence of occurrences)
    if (
      occurrence.block === union &&
      members.has(occurrence.personId) &&
      available.has(occurrence.id)
    )
      chosen.set(occurrence.personId, occurrence.id);

  for (const branch of geometry.branches || []) {
    if (branch.union !== union) continue;
    // Несколько союзов могут делить один блок размещения. Выбираем родителей
    // по концам связи конкретного союза, не подсвечивая остальных партнёров.
    for (const id of branch.id.startsWith("pair:")
      ? [branch.source, branch.target]
      : [branch.source]) {
      const personId = peopleByOccurrence.get(id);
      if (personId && members.has(personId) && available.has(id))
        chosen.set(personId, id);
    }
    const child = peopleByOccurrence.get(branch.target);
    if (
      branch.union === union &&
      child &&
      members.has(child) &&
      branch.relations.some(
        (relation) => relation.type === "parent" && relation.to === child,
      ) &&
      available.has(branch.target)
    )
      chosen.set(child, branch.target);
  }

  for (const id of memberIds)
    if (!chosen.has(id)) {
      const fallback = occurrences.find(
        (occurrence) =>
          occurrence.personId === id && available.has(occurrence.id),
      )?.id;
      if (fallback) chosen.set(id, fallback);
      else if (available.has(id)) chosen.set(id, id);
    }

  return [...chosen.values()];
}
