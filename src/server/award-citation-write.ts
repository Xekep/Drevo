import type { Family, PersonAward } from "../domain/types.ts";
import { ConflictError } from "./archive-errors.ts";

function sameAwardIdentity(before: PersonAward, after: PersonAward) {
  return before.awardDefinitionId === after.awardDefinitionId &&
    before.degreeId === after.degreeId &&
    (Boolean(before.awardDefinitionId) || before.name === after.name);
}

/** Mutates only the caller's validated clone, never the stored family. */
export function prepareAwardCitationWrite(next: Family, previous: Family | null) {
  const nextPeople = new Map(next.people.map((person) => [person.id, person]));
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
    }
  }
  return next;
}
