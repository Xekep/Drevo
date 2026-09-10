import type { Family } from "./types.ts";
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
        death: p.death,
        deceased: p.deceased,
        birthPlace: p.birthPlace,
        deathPlace: p.deathPlace,
        maidenName: p.maidenName,
        occupation: p.occupation,
        biography: p.biography,
        awards: p.awards,
        events: p.events,
        sources: p.sources,
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
      .map(({ id, from, to, type, note }) => ({ id, from, to, type, note })),
  };
}
