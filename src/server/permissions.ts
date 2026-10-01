import { isDeepStrictEqual } from "node:util";
import {
  validateFamily,
  type Family,
  type ArchiveUser,
  type Source,
} from "../domain/index.ts";
import { ForbiddenError } from "./users.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";

function catalogCitationSlots(family: Family) {
  const slots = new Map<string, Source[]>();
  const add = (path: string[], sources?: Source[]) => slots.set(JSON.stringify(path),
    (sources || []).filter((source) => source.catalogId));
  for (const person of family.people) {
    add(["person", person.id], person.sources);
    for (const claim of ["birthDateClaim", "deathDateClaim", "birthPlaceClaim", "deathPlaceClaim"] as const)
      add(["person", person.id, claim], person[claim]?.sources);
    for (const event of person.events || [])
      add(["person", person.id, "event", event.id], event.sources);
  }
  for (const union of family.unions || []) {
    add(["union", union.id], union.sources);
    for (const milestone of ["formation", "ending", "divorce", "ongoing"] as const)
      add(["union", union.id, milestone], union[milestone]?.sources);
  }
  for (const link of family.links || [])
    add(["link", link.id], link.sources);
  return slots;
}

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
  owners(next.unions || [], current.unions || []);
  const previousLinks = new Map((current.links || []).map((link) => [link.id, link]));
  for (const link of next.links || []) {
    const old = previousLinks.get(link.id);
    if (old && (old.from !== link.from || old.to !== link.to || old.type !== link.type) &&
      link.sources?.length)
      throw new ForbiddenError("При смене участников или типа связи снимите прежние источники");
  }
  if (user.role !== "admin" && user.role !== "researcher") {
    const previous = new Map(current.people.map((person) => [person.id, person]));
    for (const person of next.people)
      for (const key of ["birthDateClaim", "deathDateClaim", "birthPlaceClaim", "deathPlaceClaim"] as const) {
        const claim = person[key];
        const earlier = previous.get(person.id)?.[key];
        if (claim?.confidence !== earlier?.confidence)
          throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
      }
  }
  if (admin) return next;
  if (isScopedUser(user)) {
    const visible = visiblePersonIds(current, user);
    const oldPeople = new Map(
      current.people.map((person) => [person.id, person]),
    );
    const oldLinks = new Map(
      (current.links || []).map((link) => [link.id, link]),
    );
    const oldUnions = new Map((current.unions || []).map((union) => [union.id, union]));
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
    for (const union of next.unions || [])
      if (!union.participants.every(allowed)) {
        const old = oldUnions.get(union.id);
        if (!old || !isDeepStrictEqual(old, union)) deny();
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
      unions: undefined,
    },
    nextMeta = {
      ...next,
      people: undefined,
      photos: undefined,
      links: undefined,
      unions: undefined,
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
  const oldUnions = new Map((current.unions || []).map((union) => [union.id, union])),
    newUnions = new Map((next.unions || []).map((union) => [union.id, union]));
  for (const id of new Set([...oldUnions.keys(), ...newUnions.keys()])) {
    const a = oldUnions.get(id), b = newUnions.get(id);
    if (isDeepStrictEqual(a, b)) continue;
    for (const union of [a, b])
      if (union && (!own(union) || union.participants.some((personId) => !own(people.get(personId)!))))
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
  const previousSlots = catalogCitationSlots(current);
  for (const [path, nextSources] of catalogCitationSlots(next)) {
    const previousSources = previousSlots.get(path) || [];
    for (const source of nextSources) {
      const oldIndex = previousSources.findIndex((old) => old.catalogId === source.catalogId);
      if (oldIndex < 0)
        throw new ForbiddenError("Привязать каталожный источник может только администратор");
      const [old] = previousSources.splice(oldIndex, 1);
      if (!isDeepStrictEqual(source, old))
        throw new ForbiddenError("Изменить каталожную цитату может только администратор");
    }
  }
  return next;
}
