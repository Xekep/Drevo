import type { Family } from "../domain/types.ts";
import {
  personDetails,
  type PersonDetails,
} from "../domain/archive-projection.ts";
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
  for (const collection of ["people", "photos"] as const) {
    const total = initial.totals[collection];
    if (!Number.isSafeInteger(total) || total < 0) throw invalid();
    const seen = new Set<string>();
    const expected = new Set(initial.family.people.map((p) => p.id));
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
          (collection === "people" && !expected.has(item.id))
        )
          throw invalid();
        seen.add(item.id);
      }
      if (collection === "people") {
        const page = new Map<string, PersonDetails>(
          data.items.map((p: PersonDetails) => [p.id, personDetails(p)]),
        );
        family = {
          ...family,
          people: family.people.map((person) =>
            page.has(person.id)
              ? { ...person, ...page.get(person.id) }
              : person,
          ),
        };
      } else
        family = {
          ...family,
          photos: [...(family.photos || []), ...data.items],
        };
      offset += data.items.length;
      unpublished += data.items.length;
      if (unpublished >= archiveProgressBatchSize || offset === total) {
        progress(family);
        unpublished = 0;
      }
    }
  }
  return { ...initial, family, partial: false };
}
