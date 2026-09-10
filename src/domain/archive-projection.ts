import type { Family, Person } from "./types.ts";
export type PersonDetails = Pick<
  Person,
  "id" | "sources" | "biography" | "occupation" | "awards"
>;
export function personDetails(person: PersonDetails): PersonDetails {
  const details: PersonDetails = { id: person.id, sources: person.sources };
  if (person.biography !== undefined) details.biography = person.biography;
  if (person.occupation !== undefined) details.occupation = person.occupation;
  if (person.awards !== undefined) details.awards = person.awards;
  return details;
}
/** Скелет содержит весь граф для общей раскладки, но не тяжёлые сведения карточек. */
export function archiveOverview(family: Family): Family {
  return {
    ...family,
    photos: [],
    people: family.people.map((original) => {
      const person = { ...original, sources: [] };
      delete person.biography;
      delete person.awards;
      delete person.occupation;
      return person;
    }),
  };
}
export const archivePageSize = 40;
