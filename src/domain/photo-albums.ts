import { fullName } from "./dates.ts";
import type { ArchivePhoto, Person } from "./types.ts";
export type PhotoAlbum = { id: string; label: string; photos: ArchivePhoto[] };
export function newestPhotos(photos: ArchivePhoto[]) {
  return photos
    .map((photo, index) => ({ photo, index }))
    .sort(
      (a, b) =>
        (Date.parse(b.photo.createdAt || "") || 0) -
          (Date.parse(a.photo.createdAt || "") || 0) || b.index - a.index,
    )
    .map(({ photo }) => photo);
}
export function photoAlbums(
  photos: ArchivePhoto[],
  people: Person[],
  mode: "people" | "years",
): PhotoAlbum[] {
  const names = new Map(people.map((p) => [p.id, fullName(p)])),
    albums = new Map<string, PhotoAlbum>();
  for (const photo of newestPhotos(photos)) {
    const keys =
      mode === "years"
        ? [
            photo.year ||
              (/^\d{4}(?:-|$)/.test(photo.takenAt || "")
                ? photo.takenAt!.slice(0, 4)
                : "unknown"),
          ]
        : [
            ...new Set(
              photo.tags
                .map((tag) => tag.personId)
                .filter((id) => names.has(id)),
            ),
          ];
    if (!keys.length) keys.push("unknown");
    for (const id of keys) {
      const label =
        id === "unknown"
          ? mode === "years"
            ? "Год не указан"
            : "Без отметок людей"
          : mode === "years"
            ? id
            : names.get(id)!;
      const album = albums.get(id) || { id, label, photos: [] };
      album.photos.push(photo);
      albums.set(id, album);
    }
  }
  return [...albums.values()].sort(
    (a, b) =>
      Number(a.id === "unknown") - Number(b.id === "unknown") ||
      (mode === "years"
        ? b.label.localeCompare(a.label)
        : a.label.localeCompare(b.label, "ru")),
  );
}
