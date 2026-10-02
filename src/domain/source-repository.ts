import type { Source } from "./types.ts";

/** A repository belongs to an inline source; archive catalogue links own their metadata. */
export function validSourceRepository(source: Source): boolean {
  if (source.repository === undefined) return true;
  const repository = source.repository;
  return !source.catalogId && !!repository && typeof repository === "object" &&
    !Array.isArray(repository) &&
    [repository.name, repository.callNumber, repository.website,
      repository.note, repository.linkNote].every((value) =>
      typeof value === "string" && value.length <= 10_000) &&
    !!repository.name.trim();
}
