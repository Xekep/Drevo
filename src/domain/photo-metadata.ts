import type { ArchivePhoto } from "./types.ts";

/** Подпись строится только из известных метаданных, без имени файла и старого title. */
export const photoCaption = (photo: ArchivePhoto) =>
  [photo.year || photo.takenAt, photo.place, photo.event]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" · ");
export const photoLabel = (photo: ArchivePhoto) =>
  photoCaption(photo) || "Семейная фотография";
