import { archiveContextAt } from "./archive-context.ts";

export const archivePaths = {
  tree: "/tree",
  list: "/people",
  families: "/families",
  gallery: "/photos",
  documents: "/documents",
  places: "/places",
  insights: "/insights",
  resources: "/resources",
  quality: "/quality",
  account: "/account",
  admin: "/admin",
} as const;
export type ArchiveView = keyof typeof archivePaths;

export type ArchiveEntity =
  { kind: "person"; id: string } | { kind: "photo"; id: string };

export function archiveDocumentPath(
  personId: string | null,
  documentId: string | null,
  pageNumber?: number,
) {
  const base = personId
    ? `${archivePaths.documents}/person/${encodeURIComponent(personId)}`
    : archivePaths.documents;
  if (!documentId) return base;
  const path = `${base}/${encodeURIComponent(documentId)}`;
  return pageNumber && Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 2000
    ? `${path}/page/${pageNumber}`
    : path;
}

type ArchiveDocumentRoute = {
  personId: string | null;
  documentId: string | null;
  pageNumber?: number;
};
export function archiveDocumentAt(pathname: string): ArchiveDocumentRoute | null {
  const path = (archiveContextAt(pathname)?.innerPath || pathname).replace(/\/$/, "");
  if (path === archivePaths.documents)
    return { personId: null, documentId: null };
  const direct = /^\/documents\/([a-f0-9-]{36})(?:\/page\/([1-9]\d{0,3}))?$/i.exec(path);
  if (direct) {
    const pageNumber = direct[2] ? Number(direct[2]) : undefined;
    if (pageNumber && pageNumber > 2000) return null;
    return { personId: null, documentId: direct[1], ...(pageNumber ? { pageNumber } : {}) };
  }
  const filtered = /^\/documents\/person\/([^/]+)(?:\/([a-f0-9-]{36})(?:\/page\/([1-9]\d{0,3}))?)?$/i.exec(path);
  if (!filtered) return null;
  let personId: string;
  try {
    personId = decodeURIComponent(filtered[1]);
  } catch {
    return null;
  }
  if (
    !personId ||
    personId.length > 200 ||
    personId === "." ||
    personId === ".." ||
    [...personId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return null;
  const documentId = filtered[2] || null;
  const pageNumber = filtered[3] ? Number(filtered[3]) : undefined;
  if (pageNumber && pageNumber > 2000) return null;
  return { personId, documentId, ...(pageNumber ? { pageNumber } : {}) };
}

/** Один закодированный сегмент после /people или /photos. */
export function archiveEntityAt(pathname: string): ArchiveEntity | null {
  const match = /^\/(people|photos)\/([^/]+)\/?$/.exec(
    archiveContextAt(pathname)?.innerPath || pathname,
  );
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (
    !id ||
    id.length > 200 ||
    [...id].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    id === "." ||
    id === ".."
  )
    return null;
  return { kind: match[1] === "people" ? "person" : "photo", id };
}

/** Адреса разделов и карточек; неизвестный путь не становится файловым маршрутом. */
export function archiveViewAt(pathname: string): ArchiveView | null {
  const entity = archiveEntityAt(pathname);
  if (entity) return entity.kind === "person" ? "tree" : "gallery";
  if (archiveDocumentAt(pathname)) return "documents";
  const innerPath = archiveContextAt(pathname)?.innerPath || pathname;
  const path = innerPath.length > 1 ? innerPath.replace(/\/$/, "") : innerPath;
  if (path === "/") return "tree";
  return (
    (Object.keys(archivePaths) as ArchiveView[]).find(
      (view) => archivePaths[view] === path,
    ) || null
  );
}
