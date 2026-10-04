import type { ArchivePhoto, Family, Source } from "./types.ts";
import type { DocumentDetails } from "../shared/document-details.ts";
import type { DocumentEventLink, DocumentPage } from "../shared/document-links.ts";

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
    "createdAt" | "description" | "year" | "place" | "event" | "takenAt" | "tags"
  >;
  document?: DocumentDetails & { eventLinks?: DocumentEventLink[]; pages?: DocumentPage[] };
  embedded?: string;
  /** Drevo-only original referenced by an inline citation URL. */
  citationOnly?: boolean;
};
export type GenealogyImport = {
  family: Family;
  version: string;
  warnings: string[];
  media: TransferMedia[];
  /** Temporary import-only pointers; never persisted in Family. */
  citationMedia?: Array<{ source: Source; mediaId: string; page?: number; inlineUrlSuffix?: string }>;
  /** Standard EVENT.OBJE links awaiting verified PDF/TIFF classification. */
  eventMedia?: Array<{ mediaId: string; personId: string; eventId: string }>;
};
export type GedcomVersion = "5.5.1" | "7.0";
export type GenealogyExportFormat = "gedcom551" | "gedcom7" | "gedzip7";

export const TRANSFER_TEXT_LIMIT = 32 * 1024 * 1024;
// 480 MiB of originals plus up to 32 MiB of GEDCOM text covers the
// 500 MB base-account media quota while retaining a bounded import.
export const TRANSFER_PACKAGE_LIMIT = 512 * 1024 * 1024;
export const TRANSFER_XML_LIMIT = 256 * 1024 * 1024;
export const TRANSFER_FILE_LIMIT = 20 * 1024 * 1024;

export function localCitationMediaUrl(url: string) {
  if (!url.startsWith("/media/")) return null;
  const match = /^(\/media\/[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|tif|pdf))([?#][^\s]*)?$/.exec(url);
  if (!match) throw new Error("Некорректный путь оригинала источника");
  return { file: match[1], suffix: match[2] || "" };
}

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
      createdAt: photo.createdAt,
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
