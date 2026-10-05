import { isDeepStrictEqual } from "node:util";
import { prepareAwardCitationWrite } from "./award-citation-write.ts";
import {
  validateFamily,
  type Family,
  type ArchiveUser,
  type Source,
} from "../domain/index.ts";
import { ForbiddenError } from "./users.ts";
import { isScopedUser, visiblePersonIds } from "../domain/tree-access.ts";
import { isArchiveOwner, canAssessArchiveEvidence } from "../domain/access.ts";
import { eventHasEvidence } from "../domain/person-events.ts";

function catalogCitationSlots(family: Family) {
  const slots = new Map<string, Source[]>();
  const add = (path: string[], sources?: Source[]) => slots.set(JSON.stringify(path),
    (sources || []).filter((source) => source.catalogId));
  for (const person of family.people) {
    add(["person", person.id], person.sources);
    for (const claim of person.parentClaims || [])
      add(["person", person.id, "parent", claim.parentId], claim.sources);
    for (const claim of ["birthDateClaim", "deathDateClaim", "birthPlaceClaim", "deathPlaceClaim", "occupationClaim", "maidenNameClaim"] as const)
      add(["person", person.id, claim], person[claim]?.sources);
    for (const alternative of person.factAlternatives || [])
      add(["person", person.id, "factAlternative", alternative.id], alternative.sources);
    for (const award of person.awards || [])
      add(["person", person.id, "award", award.id], award.sources);
    for (const event of person.events || []) {
      add(["person", person.id, "event", event.id], event.sources);
      add(["person", person.id, "event", event.id, "dateClaim"], event.dateClaim?.sources);
      add(["person", person.id, "event", event.id, "placeClaim"], event.placeClaim?.sources);
      for (const alternative of event.alternatives || [])
        add(["person", person.id, "event", event.id, "alternative", alternative.id],
          alternative.sources);
    }
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
  prepareAwardCitationWrite(next, current);
  const admin = isArchiveOwner(user),
    own = (p: { createdBy?: string }) => p.createdBy === user.id;
  const nextPeople = new Map(next.people.map((person) => [person.id, person]));
  const currentPeople = new Map(current.people.map((person) => [person.id, person]));
  // An older full-snapshot client does not know this edge annotation. Preserve
  // metadata on unchanged edges, but require an explicit field to remove a
  // cited edge; the new editor sends parentClaims: [] for that operation.
  for (const previous of current.people) {
    const child = nextPeople.get(previous.id);
    if (!child || child.parentClaims !== undefined) continue;
    const retained = (previous.parentClaims || []).filter((claim) =>
      child.parents.includes(claim.parentId));
    if ((previous.parentClaims || []).some((claim) =>
      !child.parents.includes(claim.parentId)))
      throw new ForbiddenError("Обновите страницу перед изменением связи с источником");
    if (retained.length) child.parentClaims = structuredClone(retained);
  }
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
  const canAssess = canAssessArchiveEvidence(user);
  for (const previousChild of current.people) {
    const child = nextPeople.get(previousChild.id);
    for (const claim of previousChild.parentClaims || []) {
      if (!claim.confidence || canAssess) continue;
      if (!child?.parents.includes(claim.parentId))
        throw new ForbiddenError("Оценённую связь родителя с ребёнком может удалить только исследователь или администратор");
    }
  }
  for (const child of next.people) {
    const previousChild = currentPeople.get(child.id);
    for (const claim of child.parentClaims || []) {
      const previous = previousChild?.parentClaims?.find((item) => item.parentId === claim.parentId);
      if (!canAssess && claim.confidence !== previous?.confidence)
        throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
    }
    if (!canAssess)
      for (const previous of previousChild?.parentClaims || [])
        if (previous.confidence && !child.parentClaims?.some((claim) => claim.parentId === previous.parentId))
          throw new ForbiddenError("Оценённую связь родителя с ребёнком может удалить только исследователь или администратор");
  }
  if (!canAssess)
    for (const old of current.links || [])
      if (old.confidence && !next.links?.some((link) => link.id === old.id))
        throw new ForbiddenError("Оценённую связь может удалить только исследователь или администратор");
  for (const link of next.links || []) {
    const old = previousLinks.get(link.id);
    const identityChanged = old && (old.from !== link.from || old.to !== link.to ||
      old.type !== link.type);
    if (identityChanged && old.confidence && link.confidence)
      throw new ForbiddenError("При изменении связи снимите прежнюю оценку достоверности");
    if (!canAssess && link.confidence !== old?.confidence)
      throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
    if (identityChanged &&
      link.sources?.length)
      throw new ForbiddenError("При смене участников или типа связи снимите прежние источники");
  }
  const previousUnions = new Map((current.unions || []).map((union) => [union.id, union]));
  for (const union of next.unions || []) {
    const old = previousUnions.get(union.id);
    if (old) {
      const identityChanged = old.type !== union.type ||
        !old.participants.every((id) => union.participants.includes(id));
      if (identityChanged && old.confidence && union.confidence)
        throw new ForbiddenError("При изменении союза снимите прежнюю оценку достоверности");
      if (identityChanged &&
        [old.formation, old.ending, old.divorce, old.ongoing].some((stage) => stage?.confidence) &&
        [union.formation, union.ending, union.divorce, union.ongoing]
          .some((stage) => stage?.confidence))
        throw new ForbiddenError("При изменении союза снимите прежние оценки достоверности");
      for (const stage of ["formation", "ending", "divorce", "ongoing"] as const) {
        const before = old[stage], after = union[stage];
        if (before?.confidence && after?.confidence &&
          (identityChanged || before.date !== after.date ||
            before.dateText !== after.dateText || before.place !== after.place))
          throw new ForbiddenError("При изменении этапа союза снимите прежнюю оценку достоверности");
      }
      if ((old.divorce?.confidence && union.ending?.confidence) ||
        (old.ending?.confidence && union.divorce?.confidence))
        throw new ForbiddenError("При смене способа завершения союза снимите прежнюю оценку достоверности");
    }
    if (!old || (old.type === union.type &&
      old.participants.every((id) => union.participants.includes(id)))) continue;
    const oldSources = [old.sources, old.formation?.sources, old.ending?.sources,
      old.divorce?.sources, old.ongoing?.sources];
    const newSources = [union.sources, union.formation?.sources, union.ending?.sources,
      union.divorce?.sources, union.ongoing?.sources];
    if (oldSources.some((sources) => sources?.length) &&
      newSources.some((sources) => sources?.length))
      throw new ForbiddenError("При смене участников или типа союза снимите прежние источники союза и его этапов");
  }
  if (!canAssess) {
    for (const old of current.unions || []) {
      const union = next.unions?.find((item) => item.id === old.id);
      if (!union && (old.confidence ||
        [old.formation, old.ending, old.divorce, old.ongoing]
          .some((stage) => stage?.confidence)))
        throw new ForbiddenError("Оценённый союз может удалить только исследователь или администратор");
    }
    for (const union of next.unions || []) {
      const old = previousUnions.get(union.id);
      if (union.confidence !== old?.confidence)
        throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
      for (const stage of ["formation", "ending", "divorce", "ongoing"] as const)
        if (union[stage]?.confidence !== old?.[stage]?.confidence)
          throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
    }
    const previous = new Map(current.people.map((person) => [person.id, person]));
    const retained = new Set(next.people.map((person) => person.id));
    for (const person of current.people) {
      if (retained.has(person.id)) continue;
      const assessedValue = ["birthDateClaim", "deathDateClaim", "birthPlaceClaim",
        "deathPlaceClaim", "occupationClaim", "maidenNameClaim"] as const;
      if (assessedValue.some((key) => person[key]?.confidence) ||
        person.factAlternatives?.some((alternative) => alternative.confidence) ||
        person.events?.some((event) => event.dateClaim?.confidence ||
          event.placeClaim?.confidence || event.alternatives?.some((item) => item.confidence)))
        throw new ForbiddenError("Оценённую карточку может удалить только исследователь или администратор");
    }
    for (const person of next.people)
      for (const key of ["birthDateClaim", "deathDateClaim", "birthPlaceClaim", "deathPlaceClaim", "occupationClaim", "maidenNameClaim"] as const) {
        const claim = person[key];
        const earlier = previous.get(person.id)?.[key];
        if (claim?.confidence !== earlier?.confidence ||
          (earlier?.confidence && claim?.value !== earlier.value))
          throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
      }
    for (const person of next.people) {
      const earlierEvents = new Map((previous.get(person.id)?.events || [])
        .map((event) => [event.id, event]));
      const currentEvents = new Map((person.events || [])
        .map((event) => [event.id, event]));
      for (const oldEvent of earlierEvents.values())
        for (const key of ["dateClaim", "placeClaim"] as const) {
          const oldClaim = oldEvent[key];
          const currentEvent = currentEvents.get(oldEvent.id);
          const claim = currentEvent?.[key];
          if (oldClaim?.confidence && (claim?.value !== oldClaim.value ||
            currentEvent?.type !== oldEvent.type ||
            currentEvent?.title !== oldEvent.title ||
            currentEvent?.gedcomTag !== oldEvent.gedcomTag))
            throw new ForbiddenError("Оценённое утверждение может менять только исследователь или администратор");
        }
      for (const oldEvent of earlierEvents.values()) {
        const currentEvent = currentEvents.get(oldEvent.id);
        const present = new Set((currentEvent?.alternatives || []).map((item) => item.id));
        if (oldEvent.alternatives?.some((item) => item.confidence) &&
          (!currentEvent || currentEvent.type !== oldEvent.type ||
            currentEvent.title !== oldEvent.title ||
            currentEvent.gedcomTag !== oldEvent.gedcomTag))
          throw new ForbiddenError("Оценённое утверждение может менять только исследователь или администратор");
        for (const alternative of oldEvent.alternatives || [])
          if (alternative.confidence && !present.has(alternative.id))
            throw new ForbiddenError("Оценённый вариант может удалить только исследователь или администратор");
      }
      for (const event of person.events || []) {
        const oldEvent = earlierEvents.get(event.id);
        for (const key of ["dateClaim", "placeClaim"] as const)
          if (event[key]?.confidence !== oldEvent?.[key]?.confidence)
            throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
        const oldAlternatives = new Map((oldEvent?.alternatives || [])
          .map((item) => [item.id, item]));
        for (const alternative of event.alternatives || [])
          if (alternative.confidence !== oldAlternatives.get(alternative.id)?.confidence)
            throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
      }
      const earlier = new Map((previous.get(person.id)?.factAlternatives || [])
        .map((alternative) => [alternative.id, alternative]));
      const present = new Set((person.factAlternatives || []).map((alternative) => alternative.id));
      for (const alternative of earlier.values())
        if (alternative.confidence && !present.has(alternative.id))
          throw new ForbiddenError("Оценённый вариант может удалить только исследователь или администратор");
      for (const alternative of person.factAlternatives || [])
        if (alternative.confidence !== earlier.get(alternative.id)?.confidence)
          throw new ForbiddenError("Статус достоверности может менять только исследователь или администратор");
    }
  }
  for (const person of next.people) {
    const previous = current.people.find((item) => item.id === person.id);
    const old = new Map((previous?.factAlternatives || [])
      .map((alternative) => [alternative.id, alternative]));
    for (const alternative of person.factAlternatives || []) {
      const before = old.get(alternative.id);
      if (before && (before.field !== alternative.field || before.value !== alternative.value))
        throw new ForbiddenError("Для другого значения удалите прежний вариант и добавьте новый источник");
    }
    const oldEvents = new Map((previous?.events || []).map((event) => [event.id, event]));
    for (const event of person.events || []) {
      const old = new Map((oldEvents.get(event.id)?.alternatives || [])
        .map((alternative) => [alternative.id, alternative]));
      for (const alternative of event.alternatives || []) {
        const before = old.get(alternative.id);
        if (before && (before.field !== alternative.field || before.value !== alternative.value))
          throw new ForbiddenError("Для другого значения удалите прежний вариант и добавьте новый источник");
      }
    }
  }
  for (const person of next.people) {
    const oldEvents = new Map((current.people.find((item) => item.id === person.id)
      ?.events || []).map((event) => [event.id, event]));
    for (const event of person.events || []) {
      const old = oldEvents.get(event.id);
      if (!old || old.type === event.type) continue;
      if (eventHasEvidence(old) && eventHasEvidence(event))
        throw new ForbiddenError("При смене типа события снимите прежние источники события, его даты, места и вариантов");
      if (event.gedcomTag)
        throw new ForbiddenError("При смене типа события снимите прежний тип GEDCOM");
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
      if (oldIndex < 0) {
        const [kind, personId, slot, alternativeId] = JSON.parse(path) as string[];
        const oldPerson = current.people.find((person) => person.id === personId);
        const newPerson = next.people.find((person) => person.id === personId);
        const alternative = newPerson?.factAlternatives?.find((item) =>
          item.id === alternativeId && (item.field === "maidenName" || item.field === "occupation"));
        const claimKey = alternative?.field === "occupation" ? "occupationClaim" : "maidenNameClaim";
        const valueKey = alternative?.field === "occupation" ? "occupation" : "maidenName";
        const preservedClaim = kind === "person" && slot === "factAlternative" &&
          alternative && oldPerson?.[claimKey]?.value === alternative.value &&
          newPerson?.[valueKey] !== alternative.value &&
          !newPerson?.[claimKey]?.sources.some((item) => item.catalogId === source.catalogId) &&
          !oldPerson.factAlternatives?.some((item) => item.id === alternativeId) &&
          oldPerson[claimKey]!.sources.some((old) => isDeepStrictEqual(old, source));
        if (preservedClaim) continue;
        throw new ForbiddenError("Привязать каталожный источник может только администратор");
      }
      const [old] = previousSources.splice(oldIndex, 1);
      if (!isDeepStrictEqual(source, old))
        throw new ForbiddenError("Изменить каталожную цитату может только администратор");
    }
  }
  return next;
}
