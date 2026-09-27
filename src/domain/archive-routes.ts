export const archivePaths = {
  tree: "/tree",
  list: "/people",
  families: "/families",
  gallery: "/photos",
  documents: "/documents",
  places: "/places",
  insights: "/insights",
  quality: "/quality",
  admin: "/admin",
} as const;
export type ArchiveView = keyof typeof archivePaths;

export type ArchiveEntity =
  { kind: "person"; id: string } | { kind: "photo"; id: string };

/** Один закодированный сегмент после /people или /photos. */
export function archiveEntityAt(pathname: string): ArchiveEntity | null {
  const match = /^\/(people|photos)\/([^/]+)\/?$/.exec(pathname);
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
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (path === "/") return "tree";
  return (
    (Object.keys(archivePaths) as ArchiveView[]).find(
      (view) => archivePaths[view] === path,
    ) || null
  );
}
