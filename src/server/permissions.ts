import { isDeepStrictEqual } from "node:util";
import {
  validateFamily,
  type Family,
  type ArchiveUser,
} from "../domain/index.ts";
import { ForbiddenError } from "./users.ts";
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
        if (item.createdBy && item.createdBy !== user.id) deny();
        item.createdBy = user.id;
      }
    }
  }
  owners(next.people, current.people);
  owners(next.photos || [], current.photos || []);
  owners(next.links || [], current.links || []);
  if (admin) return next;
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
  for (const old of current.people) {
    const p = people.get(old.id);
    if (!p || (!own(old) && !isDeepStrictEqual(old, p))) deny();
  }
  for (const p of next.people) {
    const old = current.people.find((x) => x.id === p.id);
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
  for (const old of current.photos || []) {
    const p = photos.get(old.id);
    if (!p || (!own(old) && !isDeepStrictEqual(old, p))) deny();
  }
  for (const p of next.photos || []) {
    const old = current.photos?.find((x) => x.id === p.id);
    if (old && old.url !== p.url) deny();
  }
  return next;
}
