import type { Family, Person, ArchivePhoto } from "./types.ts";
import { newestPhotos, photoAlbums } from "./photo-albums.ts";

/** Complete event arrays preserve citations when map coordinates are edited. */
export function placesProjection(family: Family) {
  return {
    people: family.people.map(({ id, events }) => ({
      id,
      ...(events ? { events } : {}),
    })),
    photos: family.photos || [],
  };
}
export type PlacesProjection = {
  people: Pick<Person, "id" | "events">[];
  photos: ArchivePhoto[];
};
export type GalleryQuery = {
  mode: "all" | "people" | "years";
  personId?: string | null;
  /** Internal, already-authorized profile preview; not an unvalidated URL filter. */
  personIds?: readonly string[];
  year?: string | null;
  offset?: number;
  /** A client already holding this revision/query index requests only the page. */
  includeIndex?: boolean;
};
export type GalleryPage = {
  albums: { id: string; label: string; count: number; cover: string }[];
  photos: ArchivePhoto[];
  photoIds: string[];
  total: number;
  album?: { label: string; count: number };
};
export type GalleryWirePage = Omit<GalleryPage, "photoIds"> & { photoIds?: string[] };
export const galleryPageSize = 30;
/** Call only on an already authorized, revision-bound snapshot. */
export type GalleryProjectionIndex = {
  albums: ReturnType<typeof photoAlbums>;
  photos: ArchivePhoto[];
  browsingAlbums: boolean;
  album?: { label: string; count: number };
};
export function galleryProjectionIndex(
  family: Family,
  query: GalleryQuery,
): GalleryProjectionIndex {
  const names = new Set(family.people.map((p) => p.id));
  const available = (family.photos || []).filter(
    (photo) =>
      (!query.personIds || photo.tags.some(tag => query.personIds!.includes(tag.personId))) && (
      !query.personId ||
      (query.personId === "unknown"
        ? !photo.tags.some((tag) => names.has(tag.personId))
        : photo.tags.some((tag) => tag.personId === query.personId))),
  );
  const albums =
    query.mode === "all" && !query.year
      ? []
      : photoAlbums(
          available,
          family.people,
          query.mode === "people" ? "people" : "years",
        );
  const album = query.year
    ? albums.find((item) => item.id === query.year)
    : undefined;
  // An empty/missing year is an empty album, never silently the whole archive.
  const photos = query.year ? album?.photos || [] : newestPhotos(available);
  return { albums, photos, browsingAlbums: query.mode !== "all" && !query.year, ...(album ? { album: { label: album.label, count: photos.length } } : {}) };
}
export function galleryIndexPage(index: GalleryProjectionIndex, query: GalleryQuery): GalleryWirePage {
  const offset = query.offset || 0;
  if (index.browsingAlbums)
    return {
      albums: index.albums
        .slice(offset, offset + galleryPageSize)
        .map((item) => ({
          id: item.id,
          label: item.label,
          count: item.photos.length,
          cover: item.photos[0].url,
        })),
      photos: [],
      photoIds: [],
      total: index.albums.length,
    };
  return {
    albums: [],
    photos: index.photos.slice(offset, offset + galleryPageSize),
    ...(query.includeIndex === false ? {} : { photoIds: index.photos.map((photo) => photo.id) }),
    total: index.photos.length,
    ...(index.album ? { album: index.album } : {}),
  };
}
export function galleryProjection(family: Family, query: GalleryQuery): GalleryWirePage {
  return galleryIndexPage(galleryProjectionIndex(family, query), query);
}
