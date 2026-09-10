export const archivePaths = {
  tree: "/tree",
  list: "/people",
  families: "/families",
  gallery: "/photos",
  places: "/places",
  admin: "/admin",
} as const;
export type ArchiveView = keyof typeof archivePaths;

/** Только точные адреса разделов; неизвестный путь не становится файловым маршрутом. */
export function archiveViewAt(pathname: string): ArchiveView | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (path === "/") return "tree";
  return (
    (Object.keys(archivePaths) as ArchiveView[]).find(
      (view) => archivePaths[view] === path,
    ) || null
  );
}
