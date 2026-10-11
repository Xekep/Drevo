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
  year?: string | null;
  offset?: number;
};
export type GalleryPage = {
  albums: { id: string; label: string; count: number; cover: string }[];
  photos: ArchivePhoto[];
  photoIds: string[];
  total: number;
  album?: { label: string; count: number };
};
export const galleryPageSize = 30;
/** Call only on an already authorized, revision-bound snapshot. */
export function galleryProjection(
  family: Family,
  query: GalleryQuery,
): GalleryPage {
  const names = new Set(family.people.map((p) => p.id));
  const available = (family.photos || []).filter(
    (photo) =>
      !query.personId ||
      (query.personId === "unknown"
        ? !photo.tags.some((tag) => names.has(tag.personId))
        : photo.tags.some((tag) => tag.personId === query.personId)),
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
  const offset = query.offset || 0;
  if (query.mode !== "all" && !query.year)
    return {
      albums: albums
        .slice(offset, offset + galleryPageSize)
        .map((item) => ({
          id: item.id,
          label: item.label,
          count: item.photos.length,
          cover: item.photos[0].url,
        })),
      photos: [],
      photoIds: [],
      total: albums.length,
    };
  return {
    albums: [],
    photos: photos.slice(offset, offset + galleryPageSize),
    photoIds: photos.map((photo) => photo.id),
    total: photos.length,
    ...(album ? { album: { label: album.label, count: photos.length } } : {}),
  };
}
