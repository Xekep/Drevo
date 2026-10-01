import { MAX_PDF_BYTES, MAX_PHOTO_BYTES } from "./upload-limits.ts";

export type DocumentFileType = {
  extension: "pdf" | "jpg" | "png" | "webp" | "gif";
  mime: string;
  maxBytes: number;
};

const types: Record<string, DocumentFileType> = {
  pdf: { extension: "pdf", mime: "application/pdf", maxBytes: MAX_PDF_BYTES },
  jpg: { extension: "jpg", mime: "image/jpeg", maxBytes: MAX_PHOTO_BYTES },
  jpeg: { extension: "jpg", mime: "image/jpeg", maxBytes: MAX_PHOTO_BYTES },
  png: { extension: "png", mime: "image/png", maxBytes: MAX_PHOTO_BYTES },
  webp: { extension: "webp", mime: "image/webp", maxBytes: MAX_PHOTO_BYTES },
  gif: { extension: "gif", mime: "image/gif", maxBytes: MAX_PHOTO_BYTES },
};

export function documentFileTypeFromName(name: string): DocumentFileType | null {
  const extension = /\.([a-z]+)$/i.exec(name)?.[1].toLowerCase();
  return extension ? types[extension] || null : null;
}

export function documentFileTypeFromMime(mime: string): DocumentFileType | null {
  return Object.values(types).find((type) => type.mime === mime) || null;
}

export function storedDocumentFileType(name: string): DocumentFileType | null {
  return /^[a-f0-9-]{36}\.[a-z]+$/.test(name)
    ? documentFileTypeFromName(name)
    : null;
}
