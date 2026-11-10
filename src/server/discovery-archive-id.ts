import { createHash } from "node:crypto";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Must match migration 112's partial index; canonical lowercase UUIDs use the primary key. */
export const discoveryArchiveAliasPredicate = "archive_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'";

/** Existing UUIDs remain unchanged. Legacy keys get a stable UUIDv8 route
 * identifier, independent of titles, owners and publications. Not an access token.
 * Keep this namespace and encoding permanent so shared links never change. */
export function discoveryArchiveId(archiveId: string) {
  if (uuid.test(archiveId)) return archiveId.toLowerCase();
  const hex = createHash("sha256").update(`drevo:archive-route:v1:${archiveId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
