import {
  archiveEntityAt,
  archivePaths,
  type ArchiveEntity,
} from "./archive-routes.ts";

export type ArchiveTarget = ArchiveEntity;

export function archiveTargetAt(
  pathname: string,
  search: string,
): ArchiveTarget | null {
  const params = new URLSearchParams(search);
  if (params.has("person") || params.has("photo")) return null;
  return archiveEntityAt(pathname);
}

export function archiveTargetPath(target: ArchiveTarget): string {
  return `${target.kind === "person" ? archivePaths.list : "/photo"}/${encodeURIComponent(target.id)}`;
}
