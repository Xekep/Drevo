import type { Family, ArchivePhoto } from "../domain/types.ts";
import {
  personDetails,
  type PersonDetails,
} from "../domain/archive-projection.ts";
import type { ArchivePageHeader } from "./archive-pages.ts";

class DetailsChanged extends Error {}
export class ArchiveDetailsAccessError extends Error {}

/** Owns a revision-bound, demand-loaded view. No eager archive-wide hydration. */
export function archiveDetails<T extends ArchivePageHeader>(
  initial: T,
  request: (url: string) => Promise<Response>,
  publish: (header: T, refreshed?: boolean) => void,
) {
  let header = initial,
    version = 0,
    tail = Promise.resolve();
  let peopleComplete = !initial.partial || initial.totals?.people === 0,
    photosComplete = !initial.partial || initial.totals?.photos === 0;
  let loaded = new Set(
    initial.partial ? [] : initial.family.people.map((p) => p.id),
  );
  let albums = new Set<string>();
  const emit = (refreshed = false) => {
    header = { ...header, partial: !(peopleComplete && photosComplete) };
    publish(header, refreshed);
  };
  const photosWith = (photos: ArchivePhoto[]) => {
    const items = new Map(
      (header.family.photos || []).map((photo) => [photo.id, photo]),
    );
    for (const photo of photos) items.set(photo.id, photo);
    return [...items.values()];
  };
  const mergePeople = (items: PersonDetails[]) => {
    const details = new Map(
      items.map((person) => [person.id, personDetails(person)]),
    );
    header = {
      ...header,
      family: {
        ...header.family,
        people: header.family.people.map((person) => {
          const detail = details.get(person.id);
          if (!detail) return person;
          loaded.add(person.id);
          return { ...person, ...detail };
        }),
      },
    };
  };
  async function read(url: string, expectedVersion: number) {
    const response = await request(url);
    const data = await response.json();
    if (expectedVersion !== version || response.status === 409)
      throw new DetailsChanged();
    if (response.status === 401 || response.status === 403)
      throw new ArchiveDetailsAccessError(
        data.error || "Доступ к архиву изменился",
      );
    if (!response.ok)
      throw new Error(data.error || "Не удалось загрузить сведения");
    if (data.pageToken !== header.pageToken) throw new DetailsChanged();
    return data;
  }
  async function refresh() {
    const expectedVersion = version;
    const response = await request("/api/family?projection=overview");
    const data = await response.json();
    if (response.status === 401 || response.status === 403)
      throw new ArchiveDetailsAccessError(
        data.error || "Доступ к архиву изменился",
      );
    if (!response.ok)
      throw new Error(data.error || "Не удалось обновить архив");
    // A write can finish while the overview response is in flight. Its newer
    // snapshot wins; retry the demand against that snapshot instead of rolling
    // the browser back to the revision that caused the read conflict.
    if (version !== expectedVersion) return;
    if (!data.family || !Number.isSafeInteger(data.revision))
      throw new Error("Некорректный ответ архива");
    header = data;
    version++;
    loaded = new Set(
      data.partial ? [] : data.family.people.map((p: { id: string }) => p.id),
    );
    albums = new Set();
    peopleComplete = !data.partial || data.totals?.people === 0;
    photosComplete = !data.partial || data.totals?.photos === 0;
    emit(true);
  }
  function enqueue(work: () => Promise<void>) {
    const operation = tail.then(async () => {
      try {
        await work();
      } catch (error) {
        if (!(error instanceof DetailsChanged)) throw error;
        // Refresh only the light graph. Never fall back to a full snapshot on
        // an ordinary card read, and never mix pages from different revisions.
        await refresh();
        await work();
      }
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return {
    hasPerson: (id: string) => loaded.has(id),
    loadedPeople: () => new Set(loaded),
    isComplete: (collection: "people" | "photos") =>
      collection === "people" ? peopleComplete : photosComplete,
    replace(family: Family, revision: number, full = false) {
      const peopleDelta = family.people.length - header.family.people.length;
      header = {
        ...header,
        family,
        revision,
        pageToken: header.pageToken?.replace(/^\d+:/, `${revision}:`),
        ...(header.totals
          ? {
              totals: {
                ...header.totals,
                people: header.totals.people + peopleDelta,
                photos: full
                  ? family.photos?.length || 0
                  : header.totals.photos,
              },
            }
          : {}),
      };
      version++;
      if (full) {
        peopleComplete = photosComplete = true;
        loaded = new Set(family.people.map((p) => p.id));
      }
      emit();
    },
    loadPeople(ids: string[]) {
      return enqueue(async () => {
        const known = new Set(header.family.people.map((p) => p.id));
        const needed = [...new Set(ids)].filter(
          (id) =>
            known.has(id) &&
            (!loaded.has(id) || (!photosComplete && !albums.has(id))),
        );
        for (let start = 0; start < needed.length; start += 40) {
          const batch = needed.slice(start, start + 40),
            expectedVersion = version;
          let offset = 0,
            total = 0;
          const seen = new Set<string>();
          do {
            const data = await read(
              `/api/family?projection=details&ids=${encodeURIComponent(JSON.stringify(batch))}&offset=${offset}&token=${encodeURIComponent(header.pageToken || "")}`,
              expectedVersion,
            );
            if (
              !Array.isArray(data.people) ||
              data.people.length !== batch.length ||
              new Set(data.people.map((p: PersonDetails) => p.id)).size !==
                batch.length ||
              data.people.some((p: PersonDetails) => !batch.includes(p.id)) ||
              !Array.isArray(data.photos) ||
              data.photos.length > 40 ||
              !Number.isSafeInteger(data.photoTotal) ||
              data.photoTotal < 0 ||
              (offset > 0 && data.photoTotal !== total)
            )
              throw new Error("Некорректный ответ сведений");
            total = data.photoTotal;
            if (
              offset + data.photos.length > total ||
              (!data.photos.length && offset < total)
            )
              throw new Error("Некорректная страница фотографий");
            for (const photo of data.photos as ArchivePhoto[]) {
              if (
                !photo?.id ||
                seen.has(photo.id) ||
                !photo.tags.some((tag) => batch.includes(tag.personId))
              )
                throw new Error("Некорректная фотография человека");
              seen.add(photo.id);
            }
            mergePeople(data.people);
            header = {
              ...header,
              family: { ...header.family, photos: photosWith(data.photos) },
            };
            offset += data.photos.length;
            emit();
          } while (offset < total);
          batch.forEach((id) => albums.add(id));
        }
      });
    },
    loadCollections(collections: Array<"people" | "photos">) {
      return enqueue(async () => {
        for (const collection of [...new Set(collections)]) {
          if (collection === "people" ? peopleComplete : photosComplete)
            continue;
          const expectedVersion = version,
            total = header.totals?.[collection];
          if (!Number.isSafeInteger(total) || total === undefined || total < 0)
            throw new Error("Некорректный размер архива");
          const seen = new Set<string>(),
            photos: ArchivePhoto[] = [];
          const known = new Set(header.family.people.map((p) => p.id));
          for (let offset = 0; offset < total; offset += 160) {
            const offsets: number[] = Array.from(
              { length: Math.min(4, Math.ceil((total - offset) / 40)) },
              (_, i) => offset + i * 40,
            );
            const pages = await Promise.all(
              offsets.map((pageOffset) =>
                read(
                  `/api/family?projection=page&collection=${collection}&offset=${pageOffset}&token=${encodeURIComponent(header.pageToken || "")}`,
                  expectedVersion,
                ),
              ),
            );
            for (let i = 0; i < pages.length; i++) {
              const data = pages[i];
              if (
                !Array.isArray(data.items) ||
                !data.items.length ||
                data.items.length > 40 ||
                data.total !== total ||
                offsets[i] + data.items.length > total ||
                data.items.length !== Math.min(40, total - offsets[i])
              )
                throw new Error("Некорректная страница архива");
              for (const item of data.items) {
                if (
                  !item?.id ||
                  seen.has(item.id) ||
                  (collection === "people" && !known.has(item.id))
                )
                  throw new Error("Некорректная запись архива");
                seen.add(item.id);
              }
              if (collection === "people") mergePeople(data.items);
              else photos.push(...data.items);
            }
            if (collection === "photos")
              header = {
                ...header,
                family: { ...header.family, photos: [...photos] },
              };
            emit();
          }
          if (collection === "people") peopleComplete = true;
          else photosComplete = true;
          emit();
        }
      });
    },
  };
}
