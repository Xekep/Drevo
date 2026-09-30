const selectedArchive = /^\/a\/([A-Za-z0-9][A-Za-z0-9-]{2,63})(?=\/|$)/;

export function archiveContextAt(pathname: string) {
  const match = selectedArchive.exec(pathname);
  if (!match) return null;
  return {
    id: match[1],
    innerPath: pathname.slice(match[0].length) || "/",
  };
}

function browserPathname() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

/** A selected tree belongs to this browser tab's URL, not a global cookie. */
export function scopedArchivePath(path: string, pathname = browserPathname()) {
  const archive = archiveContextAt(pathname);
  return archive && path.startsWith("/") && !archiveContextAt(path)
    ? `/a/${archive.id}${path}`
    : path;
}

export function archiveResourceUrl(url: string, pathname = browserPathname()) {
  return /^\/(?:api|media)\//.test(url)
    ? scopedArchivePath(url, pathname)
    : url;
}
