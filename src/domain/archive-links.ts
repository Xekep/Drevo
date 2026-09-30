import {
  archiveEntityAt,
  archivePaths,
  type ArchiveEntity,
} from "./archive-routes.ts";
import { archiveContextAt } from "./archive-context.ts";

export type ArchiveTarget = ArchiveEntity;

export function archiveTargetAt(
  pathname: string,
  search: string,
): ArchiveTarget | null {
  const entity = archiveEntityAt(pathname);
  if (entity) return entity;
  // Старые ссылки с параметрами остаются рабочими и затем заменяются на канонический адрес.
  const route = (archiveContextAt(pathname)?.innerPath || pathname).replace(
    /\/$/,
    "",
  );
  const params = new URLSearchParams(search);
  const kind =
    route === archivePaths.tree
      ? "person"
      : route === archivePaths.gallery
        ? "photo"
        : null;
  if (!kind) return null;
  const id = params.get(kind);
  return id && id.length <= 200 ? { kind, id } : null;
}

export function archiveTargetPath(target: ArchiveTarget): string {
  return `${target.kind === "person" ? archivePaths.list : archivePaths.gallery}/${encodeURIComponent(target.id)}`;
}
