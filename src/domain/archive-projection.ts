import type { Family, Person } from "./types.ts";
/** One omission contract for in-memory and SQL overview readers. Adding a card
 * detail here must never make the initial graph silently load that detail. */
export const PERSON_DETAIL_FIELDS = [
  "sources", "biography", "occupation", "occupationClaim", "maidenNameClaim", "awards", "events",
] as const satisfies readonly (keyof Person)[];
export type PersonDetails = Pick<
  Person,
  "id" | "sources" | "biography" | "occupation" | "occupationClaim" | "maidenNameClaim" | "awards" | "events" |
  "birthDateClaim" | "deathDateClaim" | "birthPlaceClaim" | "deathPlaceClaim" | "factAlternatives" | "parentClaims"
>;
export function personDetails(person: PersonDetails): PersonDetails {
  const details: PersonDetails = { id: person.id, sources: person.sources };
  if (person.biography !== undefined) details.biography = person.biography;
  if (person.occupation !== undefined) details.occupation = person.occupation;
  if (person.occupationClaim !== undefined) details.occupationClaim = person.occupationClaim;
  if (person.maidenNameClaim !== undefined) details.maidenNameClaim = person.maidenNameClaim;
  if (person.awards !== undefined) details.awards = person.awards;
  if (person.events !== undefined) details.events = person.events;
  for (const field of ["birthDateClaim", "deathDateClaim", "birthPlaceClaim", "deathPlaceClaim", "factAlternatives", "parentClaims"] as const)
    if (person[field] !== undefined) Object.assign(details, { [field]: person[field] });
  return details;
}
/** Скелет содержит весь граф для общей раскладки, но не тяжёлые сведения карточек. */
export function archiveOverview(family: Family): Family {
  return {
    ...family,
    photos: [],
    people: family.people.map((original) => {
      const person = { ...original };
      for (const field of PERSON_DETAIL_FIELDS) {
        if (field !== "sources") delete person[field];
      }
      person.sources = [];
      return person;
    }),
  };
}
export const archivePageSize = 40;
