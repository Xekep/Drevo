import type { openArchive } from "./database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { visiblePersonIds } from "../domain/tree-access.ts";

/** Only the graph and author IDs determine visibility; never load private details/photos for a page. */
export function scopedArchiveReader(
  archive: Awaited<ReturnType<typeof openArchive>>,
) {
  const cache = new Map<string, ReadonlySet<string>>();
  return async (user: ArchiveUser) => {
    const { revision } = await archive.meta();
    const key = JSON.stringify([
      revision,
      user.id,
      user.personId,
      user.treeAccess,
    ]);
    const known = cache.get(key);
    if (known) return known;
    const { family } = await archive.overview();
    const visible = visiblePersonIds(family, user);
    cache.set(key, visible);
    // Each set is at most 10k IDs; never retain unbounded users/revisions.
    while (cache.size > 16) cache.delete(cache.keys().next().value!);
    return visible;
  };
}
