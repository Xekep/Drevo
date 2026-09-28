import type { ArchivePhoto, Family } from "./types.ts";

/** Файлы остаются вне Family до проверки сервером. Пути не дают права читать диск. */
export type TransferMedia = {
  id: string;
  file: string;
  title: string;
  mime?: string;
  personIds: string[];
  portraitIds: string[];
  photo?: Pick<
    ArchivePhoto,
    "description" | "year" | "place" | "event" | "takenAt" | "tags"
  >;
  embedded?: string;
};
export type GenealogyImport = {
  family: Family;
  version: string;
  warnings: string[];
  media: TransferMedia[];
};
export type GedcomVersion = "5.5.1" | "7.0";
export type GenealogyExportFormat =
  "gedcom551" | "gedcom7" | "gedzip7" | "drevoArchive";

export const TRANSFER_TEXT_LIMIT = 32 * 1024 * 1024;
export const TRANSFER_PACKAGE_LIMIT = 256 * 1024 * 1024;
export const TRANSFER_FILE_LIMIT = 20 * 1024 * 1024;

export function familyMedia(family: Family): TransferMedia[] {
  const media: TransferMedia[] = (family.photos || []).map((photo) => ({
    id: photo.id,
    file: photo.url,
    title: photo.title,
    personIds: [...new Set(photo.tags.map((tag) => tag.personId))],
    portraitIds: family.people
      .filter((p) => p.photo === photo.url)
      .map((p) => p.id),
    photo: {
      description: photo.description,
      year: photo.year,
      place: photo.place,
      event: photo.event,
      takenAt: photo.takenAt,
      tags: photo.tags,
    },
  }));
  for (const person of family.people) {
    if (!person.photo || media.some((item) => item.file === person.photo))
      continue;
    const people = family.people
      .filter((p) => p.photo === person.photo)
      .map((p) => p.id);
    media.push({
      id: `portrait-${person.id}`,
      file: person.photo,
      title: "Портрет",
      personIds: people,
      portraitIds: people,
    });
  }
  return media;
}
