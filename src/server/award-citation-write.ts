import { isDeepStrictEqual } from "node:util";
import type { Family, PersonAward } from "../domain/types.ts";
import { ConflictError } from "./archive-errors.ts";

// Release A accepts existing citations for reading and unchanged writes. The
// editor and new citation writes are enabled only after this backend is the
// previous release in the deployment pair.
const awardCitationWritesEnabled = false;

function sameAwardIdentity(before: PersonAward, after: PersonAward) {
  return before.awardDefinitionId === after.awardDefinitionId &&
    before.degreeId === after.degreeId &&
    (Boolean(before.awardDefinitionId) || before.name === after.name);
}

/** Mutates only the caller's validated clone, never the stored family. */
export function prepareAwardCitationWrite(next: Family, previous: Family | null) {
  const nextPeople = new Map(next.people.map((person) => [person.id, person]));
  const oldPeople = new Map((previous?.people || []).map((person) => [person.id, person]));
  for (const oldPerson of previous?.people || []) {
    const person = nextPeople.get(oldPerson.id);
    const awards = new Map((person?.awards || []).map((award) => [award.id, award]));
    for (const oldAward of oldPerson.awards || []) {
      const award = awards.get(oldAward.id);
      if (award && oldAward.sources?.length && award.sources === undefined) {
        if (!sameAwardIdentity(oldAward, award))
          throw new ConflictError("Обновите страницу перед изменением награды с источниками");
        award.sources = structuredClone(oldAward.sources);
      }
      if (!awardCitationWritesEnabled && oldAward.sources?.length &&
        (!award || !sameAwardIdentity(oldAward, award) ||
          !isDeepStrictEqual(oldAward.sources, award.sources || [])))
        throw new ConflictError("Цитаты наград пока доступны только для чтения");
    }
  }
  if (!awardCitationWritesEnabled)
    for (const person of next.people) {
      const oldAwards = new Map((oldPeople.get(person.id)?.awards || [])
        .map((award) => [award.id, award]));
      for (const award of person.awards || [])
        if (award.sources?.length &&
          !isDeepStrictEqual(oldAwards.get(award.id)?.sources || [], award.sources))
          throw new ConflictError("Цитаты наград пока доступны только для чтения");
    }
  return next;
}
