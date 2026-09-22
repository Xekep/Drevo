import { archivePaths, type ArchiveView } from "./archive-routes.ts";

export type ArchiveTarget =
  { kind: "person"; id: string } | { kind: "photo"; id: string };

export function archiveTargetAt(
  pathname: string,
  search: string,
): ArchiveTarget | null {
  const route = pathname.replace(/\/$/, "");
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
  const view: ArchiveView = target.kind === "person" ? "tree" : "gallery";
  return `${archivePaths[view]}?${new URLSearchParams({ [target.kind]: target.id })}`;
}
