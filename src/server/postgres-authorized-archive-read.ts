import type pg from "pg";
import { projectFamilyForUser } from "../domain/tree-access.ts";
import { readPostgresArchiveInTransaction } from "./postgres-archive-read.ts";
import { selectPostgresSessionArchive } from "./postgres-session-archives.ts";
import { sessionTokenHash, validSessionToken } from "./session-token.ts";

/**
 * Session and archive data must be read in the same snapshot. An archive ID
 * supplied by a client is only a selector, never proof of access.
 */
export async function readPostgresArchiveForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  now = Date.now(),
) {
  if (!validSessionToken(sessionToken) || !archiveId) return null;

  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const selected = await selectPostgresSessionArchive(
      client,
      sessionTokenHash(sessionToken),
      archiveId,
      now,
    );
    if (!selected) {
      await client.query("COMMIT");
      return null;
    }

    const archive = await readPostgresArchiveInTransaction(client, archiveId);
    const result = {
      archiveId: selected.archiveId,
      title: selected.title,
      owned: selected.owned,
      user: selected.user,
      revision: archive.revision,
      family: projectFamilyForUser(archive.family, selected.user),
    };
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
