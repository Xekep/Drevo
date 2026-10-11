import type { Family, ArchivePhoto } from "../domain/types.ts";
import {
  personDetails,
  type PersonDetails,
} from "../domain/archive-projection.ts";
import type { ArchivePageHeader } from "./archive-pages.ts";
import type {
  GalleryPage,
  GalleryQuery,
  PlacesProjection,
} from "../domain/archive-view-projection.ts";

class DetailsChanged extends Error {}
export class ArchiveDetailsAccessError extends Error {}
export class ArchiveDetailsNotFoundError extends Error {}

/** Owns a revision-bound, demand-loaded view. No eager archive-wide hydration. */
export function archiveDetails<T extends ArchivePageHeader>(
  initial: T,
  request: (url: string) => Promise<Response>,
  publish: (header: T, refreshed?: boolean) => void,
) {
  let header = initial,
    version = 0,
    running = false;
  type Task = {
    run: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const foreground: Task[] = [],
    background: Task[] = [];
  let peopleComplete = !initial.partial || initial.totals?.people === 0,
    photosComplete = !initial.partial || initial.totals?.photos === 0;
  let loaded = new Set(
    initial.partial ? [] : initial.family.people.map((p) => p.id),
  );
  let albums = new Set<string>();
  const views = new Set<"places" | "insights">();
  let projectionGeneration = 0;
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
    if (response.status === 404)
      throw new ArchiveDetailsNotFoundError(data.error || "Запись недоступна");
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
    views.clear();
    projectionGeneration++;
    version++;
    loaded = new Set(
      data.partial ? [] : data.family.people.map((p: { id: string }) => p.id),
    );
    albums = new Set();
    peopleComplete = !data.partial || data.totals?.people === 0;
    photosComplete = !data.partial || data.totals?.photos === 0;
    emit(true);
  }
  function enqueue(work: () => Promise<void>, urgent = false) {
    const run = async () => {
      try {
        await work();
      } catch (error) {
        if (!(error instanceof DetailsChanged)) throw error;
        // Refresh only the light graph. Never fall back to a full snapshot on
        // an ordinary card read, and never mix pages from different revisions.
        await refresh();
        await work();
      }
    };
    return new Promise<void>((resolve, reject) => {
      (urgent ? foreground : background).push({ run, resolve, reject });
      void pump();
    });
  }
  async function execute(task: Task) {
    try {
      await task.run();
      task.resolve();
    } catch (error) {
      task.reject(error);
    }
  }
  async function servePeople() {
    // Serve the current foreground burst, then let the collection make progress.
    const count = foreground.length;
    for (let index = 0; index < count; index++)
      await execute(foreground.shift()!);
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (foreground.length || background.length)
        await execute((foreground.shift() || background.shift())!);
    } finally {
      running = false;
    }
  }
  return {
    hasPerson: (id: string) => loaded.has(id),
    loadedPeople: () => new Set(loaded),
    projectionGeneration: () => projectionGeneration,
    hasView: (view: "places" | "insights") => views.has(view),
    insights: () => header.insights,
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
      views.clear();
      delete header.insights;
      projectionGeneration++;
      if (full) {
        peopleComplete = photosComplete = true;
        loaded = new Set(family.people.map((p) => p.id));
      }
      emit();
    },
    loadView(view: "places" | "insights") {
      return enqueue(async () => {
        if (views.has(view)) return;
        const data = await read(
          `/api/family?projection=${view}&token=${encodeURIComponent(header.pageToken || "")}`,
          version,
        );
        if (view === "places") {
          const projection = data as PlacesProjection;
          if (
            !Array.isArray(projection.people) ||
            !Array.isArray(projection.photos) ||
            projection.people.length !== header.family.people.length
          )
            throw new Error("Некорректные сведения карты");
          const byId = new Map(
            projection.people.map((person) => [person.id, person]),
          );
          if (
            byId.size !== header.family.people.length ||
            header.family.people.some((person) => !byId.has(person.id))
          )
            throw new Error("Некорректные люди карты");
          header = {
            ...header,
            family: {
              ...header.family,
              people: header.family.people.map((person) => ({
                ...person,
                events: byId.get(person.id)!.events,
              })),
              photos: projection.photos,
            },
          };
          photosComplete = true;
        } else {
          if (!data.insights || !Array.isArray(data.insights.facts))
            throw new Error("Некорректная сводка");
          header = { ...header, insights: data.insights };
        }
        views.add(view);
        emit();
      }, true);
    },
    async gallery(query: GalleryQuery): Promise<GalleryPage> {
      let page: GalleryPage | undefined;
      await enqueue(async () => {
        const params = new URLSearchParams({
          projection: "gallery",
          mode: query.mode,
          offset: String(query.offset || 0),
          token: header.pageToken || "",
          ...(query.personId ? { personId: query.personId } : {}),
          ...(query.year ? { year: query.year } : {}),
        });
        const data = await read(`/api/family?${params}`, version);
        if (
          !Array.isArray(data.photos) ||
          data.photos.length > 30 ||
          !Array.isArray(data.albums) ||
          data.albums.length > 30 ||
          !Array.isArray(data.photoIds) ||
          !Number.isSafeInteger(data.total) ||
          data.total < 0
        )
          throw new Error("Некорректная страница галереи");
        const browsingAlbums = query.mode !== "all" && !query.year;
        const items = browsingAlbums ? data.albums : data.photos;
        if (
          new Set(items.map((item: { id: string }) => item.id)).size !==
            items.length ||
          (query.offset || 0) + items.length > data.total ||
          (!items.length && (query.offset || 0) < data.total) ||
          (browsingAlbums
            ? data.photos.length || data.photoIds.length
            : data.albums.length ||
              data.photoIds.length !== data.total ||
              new Set(data.photoIds).size !== data.total ||
              data.photos.some(
                (photo: ArchivePhoto) => !data.photoIds.includes(photo.id),
              ))
        )
          throw new Error("Неполная страница галереи");
        page = data;
        header = {
          ...header,
          family: { ...header.family, photos: photosWith(data.photos) },
        };
        emit();
      }, true);
      return page!;
    },
    loadPhotos(ids: string[]) {
      return enqueue(async () => {
        const known = new Set(
          (header.family.photos || []).map((photo) => photo.id),
        );
        const needed = [...new Set(ids)].filter((id) => !known.has(id));
        for (let start = 0; start < needed.length; start += 40) {
          const batch = needed.slice(start, start + 40);
          const data = await read(
            `/api/family?projection=photos&ids=${encodeURIComponent(JSON.stringify(batch))}&token=${encodeURIComponent(header.pageToken || "")}`,
            version,
          );
          if (
            !Array.isArray(data.photos) ||
            data.photos.length !== batch.length ||
            new Set(data.photos.map((photo: ArchivePhoto) => photo.id)).size !==
              batch.length ||
            data.photos.some((photo: ArchivePhoto) => !batch.includes(photo.id))
          )
            throw new Error("Некорректная фотография");
          header = {
            ...header,
            family: { ...header.family, photos: photosWith(data.photos) },
          };
          emit();
        }
      }, true);
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
      }, true);
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
                family: {
                  ...header.family,
                  photos: [
                    ...photos,
                    ...(header.family.photos || []).filter(
                      (photo) => !seen.has(photo.id),
                    ),
                  ],
                },
              };
            emit();
            // Yield between bounded page groups. Card requests remain serialized
            // with this reader, so revision/access checks are never bypassed.
            await servePeople();
          }
          if (collection === "people") peopleComplete = true;
          else photosComplete = true;
          emit();
        }
      });
    },
  };
}
