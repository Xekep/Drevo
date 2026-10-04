import type { Person } from "./types.ts";

/** Keep an existing birth-surname citation attached to its old value when editing the displayed one. */
export function preserveBirthSurnameClaim(person: Person, alternativeId: string): Person {
  const claim = person.maidenNameClaim;
  if (!claim || claim.value === person.maidenName) return person;
  return {
    ...person,
    maidenNameClaim: undefined,
    factAlternatives: [...(person.factAlternatives || []), {
      ...claim, id: alternativeId, field: "maidenName",
    }],
  };
}

/** Keep the cited former occupation as a competing value without changing its evidence. */
export function preserveOccupationClaim(person: Person, alternativeId: string): Person {
  const claim = person.occupationClaim;
  if (!claim || claim.value === person.occupation) return person;
  return {
    ...person,
    occupationClaim: undefined,
    factAlternatives: [...(person.factAlternatives || []), {
      ...claim, id: alternativeId, field: "occupation",
    }],
  };
}
