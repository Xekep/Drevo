import type { ArchiveUser } from "./access.ts";
import type { Family } from "./types.ts";
import {
  commonAncestorNetwork,
  familyNeighbors,
} from "./family-neighborhood.ts";

export function isScopedUser(user: ArchiveUser | null): user is ArchiveUser {
  return (
    !!user && user.role !== "admin" && user.treeAccess === "common_ancestors"
  );
}

/** Новые отдельные ветви автора остаются ему доступны после сохранения. */
export function visiblePersonIds(family: Family, user: ArchiveUser) {
  if (!isScopedUser(user))
    return new Set(family.people.map((person) => person.id));
  const ids = user.personId
    ? commonAncestorNetwork(familyNeighbors(family), user.personId)
    : new Set<string>();
  for (const person of family.people)
    if (person.createdBy === user.id) ids.add(person.id);
  return ids;
}

export function projectFamilyForUser(family: Family, user: ArchiveUser | null) {
  if (!isScopedUser(user)) return family;
  const visible = visiblePersonIds(family, user);
  return {
    ...family,
    people: family.people
      .filter((person) => visible.has(person.id))
      .map((person) => ({
        ...person,
        parents: person.parents.filter((id) => visible.has(id)),
        spouses: person.spouses.filter((id) => visible.has(id)),
      })),
    links: family.links?.filter(
      (link) => visible.has(link.from) && visible.has(link.to),
    ),
    unions: family.unions?.filter((union) => union.participants.every((id) => visible.has(id))),
    photos: family.photos
      ?.filter(
        (photo) =>
          photo.createdBy === user.id ||
          photo.tags.some((tag) => visible.has(tag.personId)),
      )
      .map((photo) => ({
        ...photo,
        tags: photo.tags.filter((tag) => visible.has(tag.personId)),
      })),
  } satisfies Family;
}
