import type { Family, Person, Source } from "./types.ts";

/** Match the people and relationship edges included by export-visible. */
export function visibleGenealogyHasCatalogLinks(family: Family, visible: Set<string>): boolean {
  const linked = (sources?: Source[]) => sources?.some((source) => Boolean(source.catalogId)) ?? false;
  const personLinked = (person: Person) =>
    linked(person.sources) ||
    [person.birthDateClaim, person.deathDateClaim, person.birthPlaceClaim,
      person.deathPlaceClaim, person.occupationClaim, person.maidenNameClaim]
      .some((claim) => linked(claim?.sources)) ||
    person.factAlternatives?.some((alternative) => linked(alternative.sources)) ||
    person.parentClaims?.some((claim) => visible.has(claim.parentId) && linked(claim.sources)) ||
    person.events?.some((event) =>
      linked(event.sources) || linked(event.dateClaim?.sources) || linked(event.placeClaim?.sources) ||
      event.alternatives?.some((alternative) => linked(alternative.sources))) || false;

  return family.people.some((person) => visible.has(person.id) && personLinked(person)) ||
    (family.unions || []).some((union) => union.participants.every((id) => visible.has(id)) && (
      linked(union.sources) || linked(union.formation?.sources) || linked(union.ending?.sources) ||
      linked(union.divorce?.sources) || linked(union.ongoing?.sources))) ||
    (family.links || []).some((link) =>
      visible.has(link.from) && visible.has(link.to) && linked(link.sources));
}
