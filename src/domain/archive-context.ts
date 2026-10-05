const selectedArchive = /^\/a\/([A-Za-z0-9][A-Za-z0-9-]{2,63})(?=\/|$)/;

export function archiveContextAt(pathname: string) {
  const match = selectedArchive.exec(pathname);
  if (!match) return null;
  return {
    id: match[1],
    innerPath: pathname.slice(match[0].length) || "/",
  };
}

/** A view-as URL is scoped to one selected archive and one participant. */
export function memberPreviewAt(pathname: string) {
  const archive = archiveContextAt(pathname);
  const match = /^\/preview\/([^/]{1,1200})(?=\/|$)/.exec(archive?.innerPath || pathname);
  if (!match) return null;
  try {
    const memberId = decodeURIComponent(match[1]);
    if (!memberId || memberId.length > 200 || memberId === "." || memberId === ".." ||
        /[\p{Cc}/%\\]/u.test(memberId)) return null;
    return {
      archiveId: archive?.id || null,
      memberId,
      prefix: `${archive ? `/a/${archive.id}` : ""}/preview/${encodeURIComponent(memberId)}`,
      innerPath: (archive?.innerPath || pathname).slice(match[0].length) || "/",
    };
  } catch { return null; }
}

export function memberPreviewPath(archiveId: string | null, memberId: string) {
  if ((archiveId && !/^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/.test(archiveId)) ||
      !memberId || memberId.length > 200 || memberId === "." || memberId === ".." ||
      /[\p{Cc}/%\\]/u.test(memberId))
    throw new Error("Invalid preview target");
  return `${archiveId ? `/a/${archiveId}` : ""}/preview/${encodeURIComponent(memberId)}/tree`;
}

function browserPathname() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function browserOrigin() {
  return typeof window === "undefined" ? "https://drevo.invalid" : window.location.origin;
}

/** A selected tree belongs to this browser tab's URL, not a global cookie. */
export function scopedArchivePath(path: string, pathname = browserPathname()) {
  const archive = archiveContextAt(pathname);
  const preview = memberPreviewAt(pathname);
  return (archive || preview) && path.startsWith("/") &&
      !archiveContextAt(path) && !memberPreviewAt(path)
    ? `${preview?.prefix || `/a/${archive!.id}`}${path}`
    : path;
}

export function archiveResourceUrl(
  url: string,
  pathname = browserPathname(),
  origin = browserOrigin(),
) {
  const preview = memberPreviewAt(pathname);
  if (preview) {
    const unavailable = `${preview.prefix}/api/unavailable`;
    let resolved: URL;
    try { resolved = new URL(url, origin); } catch { return unavailable; }
    if (resolved.origin !== origin)
      return resolved.protocol === "https:" || resolved.protocol === "http:"
        ? url : unavailable;
    const authority = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/?#]*/.exec(url);
    const raw = authority ? url.slice(authority[0].length) : url;
    if (/(?:^|\/)(?:\.|%2e){1,2}(?=\/|[?#]|$)/i.test(raw)) return unavailable;
    const rootResource = /^\/(?:api|media)\//.test(raw);
    const candidate = rootResource ? `${preview.prefix}${raw}` : raw;
    let normalized: URL;
    try { normalized = new URL(candidate, origin); } catch { return unavailable; }
    if (normalized.origin !== origin ||
        !(normalized.pathname.startsWith(`${preview.prefix}/api/`) ||
          normalized.pathname.startsWith(`${preview.prefix}/media/`)))
      return unavailable;
    return `${normalized.pathname}${normalized.search}${normalized.hash}`;
  }
  return /^\/(?:api|media)\//.test(url)
    ? scopedArchivePath(url, pathname)
    : url;
}
