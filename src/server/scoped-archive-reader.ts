import type { openArchive } from "./database.ts";

/** Every endpoint shares the runtime's bounded graph/visibility cache. */
export function scopedArchiveReader(
  archive: Awaited<ReturnType<typeof openArchive>>,
) {
  return archive.visibleIds;
}
