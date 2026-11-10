import type { ArchivePhoto } from "./types.ts";
import { dateBound, normalizeDateInput } from "./dates.ts";

/** Only recorded shooting dates determine chronology; upload dates are not history. */
function shootingDate(photo: ArchivePhoto): number | null {
  for (const value of [photo.takenAt, photo.year]) {
    try {
      const date = normalizeDateInput(value || "");
      if (date) return Date.parse(`${dateBound(date, false)}T00:00:00Z`);
    } catch {
      /* Free-form shooting periods remain text; a recorded year can still order them. */
    }
  }
  return null;
}

/** A branch is the captured visible set, never inferred from surnames or photo titles. */
export function chroniclePhotos(
  photos: readonly ArchivePhoto[],
  personIds: readonly string[],
): ArchivePhoto[] {
  const people = new Set(personIds),
    seen = new Set<string>();
  return photos
    .filter((photo) => {
      if (
        seen.has(photo.id) ||
        !photo.tags.some((tag) => people.has(tag.personId))
      )
        return false;
      seen.add(photo.id);
      return true;
    })
    .map((photo) => ({ photo, date: shootingDate(photo) }))
    .sort((a, b) =>
      a.date === b.date
        ? a.photo.id.localeCompare(b.photo.id, "en")
        : a.date === null
          ? 1
          : b.date === null
            ? -1
            : a.date - b.date,
    )
    .map(({ photo }) => photo);
}
