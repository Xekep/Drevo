import { isDeepStrictEqual } from "node:util";
import {
  validateFamily,
  type Family,
  type ArchiveUser,
} from "../domain/index.ts";
import { ForbiddenError } from "./users.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
/** Проверяет весь снимок, включая изменения чужих узлов через связи. Автор назначается сервером. */
export function authorizeArchive(
  nextValue: unknown,
  current: Family,
  user: ArchiveUser,
): Family {
  const next = structuredClone(validateFamily(nextValue));
  if (user.role === "reader")
    throw new ForbiddenError("Доступен только просмотр архива");
  const admin = user.role === "admin",
    own = (p: { createdBy?: string }) => p.createdBy === user.id;
  const deny = () => {
    throw new ForbiddenError(
      "Можно добавлять и редактировать только свои карточки и фотографии",
    );
  };
  function owners<T extends { id: string; createdBy?: string }>(
    items: T[],
    before: T[],
  ) {
    const map = new Map(before.map((p) => [p.id, p]));
    for (const item of items) {
      const old = map.get(item.id);
      if (old) {
        if (item.createdBy !== old.createdBy) deny();
      } else {
        if (!admin) {
          if (item.createdBy && item.createdBy !== user.id) deny();
          item.createdBy = user.id;
        }
      }
    }
  }
  owners(next.people, current.people);
  owners(next.photos || [], current.photos || []);
  owners(next.links || [], current.links || []);
  if (admin) return next;
  if (isScopedUser(user)) {
    const visible = visiblePersonIds(current, user);
    const oldPeople = new Map(
      current.people.map((person) => [person.id, person]),
    );
    const oldLinks = new Map(
      (current.links || []).map((link) => [link.id, link]),
    );
    const oldPhotos = new Map(
      (current.photos || []).map((photo) => [photo.id, photo]),
    );
    const added = new Set(
      next.people
        .filter((person) => !oldPeople.has(person.id))
        .map((person) => person.id),
    );
    const allowed = (id: string) => visible.has(id) || added.has(id);
    for (const person of next.people) {
      const old = oldPeople.get(person.id);
      if (
        (!old || !isDeepStrictEqual(old, person)) &&
        [...person.parents, ...person.spouses].some((id) => !allowed(id))
      )
        deny();
    }
    for (const link of next.links || [])
      if (!allowed(link.from) || !allowed(link.to)) {
        const old = oldLinks.get(link.id);
        if (!old || !isDeepStrictEqual(old, link)) deny();
      }
    for (const photo of next.photos || []) {
      const old = oldPhotos.get(photo.id);
      if (
        (!old || !isDeepStrictEqual(old, photo)) &&
        photo.tags.some((tag) => !allowed(tag.personId))
      )
        deny();
    }
  }
  const currentMeta = {
      ...current,
      people: undefined,
      photos: undefined,
      links: undefined,
    },
    nextMeta = {
      ...next,
      people: undefined,
      photos: undefined,
      links: undefined,
    };
  if (!isDeepStrictEqual(currentMeta, nextMeta)) deny();
  const people = new Map(next.people.map((p) => [p.id, p]));
  const previousPeople = new Map(current.people.map((p) => [p.id, p]));
  for (const old of current.people) {
    const p = people.get(old.id);
    if (!p || (!own(old) && !isDeepStrictEqual(old, p))) deny();
  }
  for (const p of next.people) {
    const old = previousPeople.get(p.id);
    if (!own(p)) continue;
    const changedSpouses = new Set([
      ...(old?.spouses || []).filter((id) => !p.spouses.includes(id)),
      ...p.spouses.filter((id) => !old?.spouses.includes(id)),
    ]);
    for (const id of changedSpouses)
      if (!people.get(id) || !own(people.get(id)!)) deny();
  }
  // Дополнительные связи родственник может менять только между своими карточками.
  const oldLinks = new Map((current.links || []).map((l) => [l.id, l])),
    newLinks = new Map((next.links || []).map((l) => [l.id, l]));
  for (const id of new Set([...oldLinks.keys(), ...newLinks.keys()])) {
    const a = oldLinks.get(id),
      b = newLinks.get(id);
    if (isDeepStrictEqual(a, b)) continue;
    for (const l of [a, b])
      if (
        l &&
        (!own(l) ||
          !people.get(l.from) ||
          !own(people.get(l.from)!) ||
          !people.get(l.to) ||
          !own(people.get(l.to)!))
      )
        deny();
  }
  const photos = new Map((next.photos || []).map((p) => [p.id, p]));
  const previousPhotos = new Map((current.photos || []).map((p) => [p.id, p]));
  for (const old of current.photos || []) {
    const p = photos.get(old.id);
    if (!p || (!own(old) && !isDeepStrictEqual(old, p))) deny();
  }
  for (const p of next.photos || []) {
    const old = previousPhotos.get(p.id);
    if (old && old.url !== p.url) deny();
  }
  return next;
}
