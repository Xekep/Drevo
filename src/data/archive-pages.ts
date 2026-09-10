import type { Family } from "../domain/types.ts";
import { personDetails } from "../domain/archive-projection.ts";
export type ArchivePageHeader = {
  family: Family;
  revision: number;
  partial?: boolean;
  pageToken?: string;
  totals?: { people: number; photos: number };
};

/** Не заставляем React пересобирать весь архив после каждой сетевой страницы. */
export const archiveProgressBatchSize = 160;

/** Все страницы относятся к одной ревизии и одному набору разрешений. */
export async function completeArchive<T extends ArchivePageHeader>(
  initial: T,
  request: (url: string) => Promise<Response>,
  progress: (family: Family) => void,
): Promise<T> {
  if (!initial.partial) return initial;
  const invalid = () =>
    new Error("Архив изменился во время загрузки. Обновите страницу.");
  if (
    !initial.pageToken ||
    !initial.totals ||
    initial.family.people.length !== initial.totals.people ||
    (initial.family.photos?.length || 0) !== 0
  )
    throw invalid();

  let family = initial.family;
  const workingPeople = [...initial.family.people],
    peopleIndex = new Map(workingPeople.map((person, index) => [person.id, index])),
    workingPhotos = [...(initial.family.photos || [])];

  for (const collection of ["people", "photos"] as const) {
    const total = initial.totals[collection];
    if (!Number.isSafeInteger(total) || total < 0) throw invalid();
    const seen = new Set<string>();
    let unpublished = 0;
    for (let offset = 0; offset < total;) {
      const response = await request(
        `/api/family?projection=page&collection=${collection}&offset=${offset}&token=${encodeURIComponent(initial.pageToken!)}`,
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Не удалось загрузить следующую часть архива",
        );
      if (
        data.pageToken !== initial.pageToken ||
        !Array.isArray(data.items) ||
        !data.items.length ||
        data.total !== total ||
        offset + data.items.length > total
      )
        throw invalid();

      for (const item of data.items) {
        if (
          !item ||
          typeof item.id !== "string" ||
          seen.has(item.id) ||
          (collection === "people" && !peopleIndex.has(item.id))
        )
          throw invalid();
        seen.add(item.id);
        if (collection === "people") {
          const index = peopleIndex.get(item.id)!;
          workingPeople[index] = {
            ...workingPeople[index],
            ...personDetails(item),
          };
        } else workingPhotos.push(item);
      }

      offset += data.items.length;
      unpublished += data.items.length;
      if (unpublished >= archiveProgressBatchSize || offset === total) {
        family =
          collection === "people"
            ? { ...family, people: [...workingPeople] }
            : { ...family, photos: [...workingPhotos] };
        progress(family);
        unpublished = 0;
      }
    }
  }
  return { ...initial, family, partial: false };
}
