import type { Family, PersonValueClaim, Source, UnionMilestone } from "./types.ts";
const publicSource = (source: Source): Source => ({
  title: source.title,
  type: source.type,
  reference: source.reference,
  ...(source.catalogId !== undefined ? { catalogId: source.catalogId } : {}),
  ...(source.url !== undefined ? { url: source.url } : {}),
  ...(source.note !== undefined ? { note: source.note } : {}),
  ...(source.repository ? { repository: {
    name: source.repository.name,
    callNumber: source.repository.callNumber,
    website: source.repository.website,
    note: source.repository.note,
    linkNote: source.repository.linkNote,
  } } : {}),
});
const publicClaim = (claim?: PersonValueClaim): PersonValueClaim | undefined =>
  claim && { value: claim.value, sources: claim.sources.map(publicSource),
    ...(claim.confidence !== undefined ? { confidence: claim.confidence } : {}) };
const publicMilestone = (milestone?: UnionMilestone): UnionMilestone | undefined =>
  milestone && { date: milestone.date, dateText: milestone.dateText,
    place: milestone.place, sources: milestone.sources?.map(publicSource),
    ...(milestone.confidence !== undefined ? { confidence: milestone.confidence } : {}) };
export type ShareLink = {
  id: string;
  title: string;
  anchorId: string;
  personIds: string[];
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  createdName: string;
  revokedAt: string | null;
  lastVisitedAt: string | null;
};
/** Отдельная граница доступа: ни глобальных метаданных, ни концов связей за пределами выдачи. */
export function sharedFamily(
  family: Family,
  share: ShareLink,
  token: string,
): Family {
  const ids = new Set(share.personIds);
  return {
    title: share.title,
    description: "",
    demo: false,
    photos: [],
    people: family.people
      .filter((p) => ids.has(p.id))
      .map((p) => ({
        id: p.id,
        surname: p.surname,
        name: p.name,
        patronymic: p.patronymic,
        sex: p.sex,
        birth: p.birth,
        birthDateClaim: publicClaim(p.birthDateClaim),
        death: p.death,
        deathDateClaim: publicClaim(p.deathDateClaim),
        deceased: p.deceased,
        needsReview: p.needsReview,
        birthPlace: p.birthPlace,
        birthPlaceClaim: publicClaim(p.birthPlaceClaim),
        deathPlace: p.deathPlace,
        deathPlaceClaim: publicClaim(p.deathPlaceClaim),
        maidenName: p.maidenName,
        maidenNameClaim: publicClaim(p.maidenNameClaim),
        occupation: p.occupation,
        occupationClaim: publicClaim(p.occupationClaim),
        factAlternatives: p.factAlternatives?.map((alternative) => ({
          id: alternative.id, field: alternative.field, value: alternative.value,
          sources: alternative.sources.map(publicSource),
          ...(alternative.confidence !== undefined ? { confidence: alternative.confidence } : {}),
        })),
        biography: p.biography,
        awards: p.awards?.map((award) => ({
          id: award.id,
          name: award.name,
          awardDefinitionId: award.awardDefinitionId,
          degreeId: award.degreeId,
          year: award.year,
          source: award.source && { title: award.source.title, url: award.source.url },
        })),
        events: p.events?.map((event) => ({
          id: event.id,
          gedcomTag: event.gedcomTag,
          type: event.type,
          title: event.title,
          date: event.date,
          endDate: event.endDate,
          dateText: event.dateText,
          place: event.place,
          location: event.location && { place: event.location.place,
            lat: event.location.lat, lon: event.location.lon,
            ...(event.location.label !== undefined ? { label: event.location.label } : {}) },
          description: event.description,
          sources: event.sources?.map(publicSource),
          dateClaim: event.dateClaim && { value: event.dateClaim.value,
            ...(event.dateClaim.confidence ? { confidence: event.dateClaim.confidence } : {}),
            sources: event.dateClaim.sources.map(publicSource) },
          placeClaim: event.placeClaim && { value: event.placeClaim.value,
            ...(event.placeClaim.confidence ? { confidence: event.placeClaim.confidence } : {}),
            sources: event.placeClaim.sources.map(publicSource) },
          alternatives: event.alternatives?.map((alternative) => ({
            id: alternative.id, field: alternative.field, value: alternative.value,
            sources: alternative.sources.map(publicSource),
            ...(alternative.confidence !== undefined ? { confidence: alternative.confidence } : {}),
          })),
        })),
        sources: p.sources.map(publicSource),
        photo: p.photo?.startsWith("/media/")
          ? `/api/shared/${token}/portrait/${encodeURIComponent(p.id)}`
          : undefined,
        parents: p.parents.filter((id) => ids.has(id)),
        spouses: p.spouses.filter((id) => ids.has(id)),
        parentageComplete:
          p.parentageComplete && p.parents.every((id) => ids.has(id)),
        generation: 1,
        column: 0,
      })),
    links: (family.links || [])
      .filter((l) => ids.has(l.from) && ids.has(l.to))
      .map(({ id, from, to, type, note, confidence }) => ({ id, from, to, type, note,
        ...(confidence !== undefined ? { confidence } : {}) })),
    unions: (family.unions || [])
      .filter((union) => union.participants.every((id) => ids.has(id)))
      .map((union) => ({
        id: union.id,
        participants: [union.participants[0], union.participants[1]],
        type: union.type,
        ...(union.confidence !== undefined ? { confidence: union.confidence } : {}),
        note: union.note,
        sources: union.sources?.map(publicSource),
        formation: publicMilestone(union.formation),
        ending: publicMilestone(union.ending),
        divorce: publicMilestone(union.divorce),
        ongoing: publicMilestone(union.ongoing),
      })),
  };
}
