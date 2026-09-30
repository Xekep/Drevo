import { createHash } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";

/** A bearer token may open only the archive that issued it. */
export function publicShareAccess(db: StoreDatabase) {
  const setArchive =
    db.kind === "postgres"
      ? db.prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      : null;
  const validShare =
    db.kind === "postgres"
      ? db.prepare(
          "",
          "SELECT 1 FROM runtime_visible_share_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
        )
      : null;
  return async (archiveId: string, token: string) => {
    if (!setArchive || !validShare || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return false;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return await db.transaction(async () => {
      await setArchive.get(archiveId);
      return !!(await validShare.get(tokenHash, new Date().toISOString()));
    }, true);
  };
}
