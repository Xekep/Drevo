import { archiveContextAt, memberPreviewAt } from "./archive-context.ts";

/** Opaque invitations do not expose the archive identifier in copied links. */
export function invitationAt(pathname: string): { token: string } | null {
  const short = /^\/join\/([A-Za-z0-9_-]{43})$/.exec(pathname);
  if (short) return { token: short[1] };
  return null;
}

const innerViewPath = (pathname: string) =>
  memberPreviewAt(pathname)?.innerPath || archiveContextAt(pathname)?.innerPath || pathname;

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
  manage: "/manage",
  admin: "/admin",
} as const;
export type ArchiveView = keyof typeof archivePaths;
export const adminMatchesPath = "/manage/matches";

type MatchTarget = { archiveId: string; personId: string };
const matchArchiveId = /^[A-Za-z0-9-]{3,64}$/;
function matchPersonId(value: string) {
  if (!value || value.length > 100 || value === "." || value === ".." ||
      /[\p{Cc}/%\\]/u.test(value)) return false;
  try { encodeURIComponent(value); return true; }
  catch { return false; }
}

/** An exact published card can be handed to the owner of a different archive. */
export function adminMatchTargetPath(ownArchiveId: string, target: MatchTarget) {
  if (!matchArchiveId.test(ownArchiveId) || !matchArchiveId.test(target.archiveId) ||
      ownArchiveId === target.archiveId || !matchPersonId(target.personId))
    throw new Error("Invalid match target");
  return `/a/${ownArchiveId}${adminMatchesPath}/target/${target.archiveId}/${encodeURIComponent(target.personId)}`;
}

export function adminMatchTargetAt(pathname: string): MatchTarget | null {
  const archive = archiveContextAt(pathname);
  const match = archive && /^\/manage\/matches\/target\/([A-Za-z0-9-]{3,64})\/([^/]{1,1200})$/.exec(archive.innerPath);
  if (!match || match[1] === archive.id) return null;
  try {
    const personId = decodeURIComponent(match[2]);
    return matchPersonId(personId) ? { archiveId: match[1], personId } : null;
  } catch { return null; }
}

/** Open matching for one card in the selected archive without a name search. */
export function adminMatchSourcePath(archiveId: string, personId: string) {
  if (!matchArchiveId.test(archiveId) || !matchPersonId(personId))
    throw new Error("Invalid match source");
  return `/a/${archiveId}${adminMatchesPath}/from/${encodeURIComponent(personId)}`;
}

export function adminMatchSourceAt(pathname: string): string | null {
  const archive = archiveContextAt(pathname);
  const match = archive && /^\/manage\/matches\/from\/([^/]{1,1200})$/.exec(archive.innerPath);
  if (!match) return null;
  try {
    const personId = decodeURIComponent(match[1]);
    return matchPersonId(personId) ? personId : null;
  } catch { return null; }
}

export type ArchiveEntity =
  { kind: "person"; id: string } | { kind: "photo"; id: string };

export function archiveAlbumPath(personId: string | null, year: string | null = null) {
  const base = personId ? `/photos/${encodeURIComponent(personId)}` : archivePaths.gallery;
  return year ? `${base}?${new URLSearchParams({ year })}` : base;
}

export function archiveAlbumAt(pathname: string): string | null {
  const match = /^\/photos\/([^/]+)\/?$/.exec(innerViewPath(pathname));
  return match ? archiveEntityAt(`/people/${match[1]}`)?.id || null : null;
}

export function discoveryPageAt(pathname: string, search = "") {
  if (search) return null;
  if (pathname === "/discover") return { query: null, archiveId: null, personId: null };
  const query = /^\/discover\/search\/([^/]{1,1200})$/.exec(pathname);
  if (query) {
    try {
      const value = decodeURIComponent(query[1]);
      return value.length <= 100 && !/[\p{Cc}]/u.test(value)
        ? { query: value, archiveId: null, personId: null } : null;
    } catch { return null; }
  }
  const person = /^\/discover\/person\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([^/]{1,1200})$/i.exec(pathname);
  const id = person && archiveEntityAt(`/people/${person[2]}`)?.id;
  return person && id && matchPersonId(id) ? { query: null, archiveId: person[1], personId: id } : null;
}

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
  const path = innerViewPath(pathname).replace(/\/$/, "");
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

/** Один закодированный сегмент после /people или /photo. */
export function archiveEntityAt(pathname: string): ArchiveEntity | null {
  const match = /^\/(people|photo)\/([^/]+)\/?$/.exec(
    innerViewPath(pathname),
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
export function archiveViewAt(pathname: string, search = ""): ArchiveView | null {
  const query = new URLSearchParams(search);
  const inner = innerViewPath(pathname).replace(/\/$/, "");
  if (((inner === "/tree" || inner === "/") && query.has("person")) ||
      (inner === "/photos" && (query.has("photo") || query.has("personId"))) ||
      (inner === "/documents" && (query.has("personId") || query.has("documentId")))) return null;
  if (memberPreviewAt(pathname) &&
      /^\/(?:account|admin|manage)(?:\/|$)/.test(innerViewPath(pathname)))
    return null;
  if (archiveContextAt(pathname) && /^\/admin(?:\/|$)/.test(inner)) return null;
  const entity = archiveEntityAt(pathname);
  if (entity) return entity.kind === "person" ? "tree" : "gallery";
  if (archiveAlbumAt(pathname)) return "gallery";
  if (archiveDocumentAt(pathname)) return "documents";
  const innerPath = innerViewPath(pathname);
  const path = innerPath.length > 1 ? innerPath.replace(/\/$/, "") : innerPath;
  if (path === "/") return "tree";
  if (path === adminMatchesPath) return "manage";
  if (adminMatchTargetAt(pathname)) return "manage";
  if (adminMatchSourceAt(pathname)) return "manage";
  return (
    (Object.keys(archivePaths) as ArchiveView[]).find(
      (view) => archivePaths[view] === path,
    ) || null
  );
}
