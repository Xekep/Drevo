import type pg from "pg";
import { projectFamilyForUser } from "../domain/tree-access.ts";
import { isArchiveOwner } from "../domain/access.ts";
import { postgresAccessReader } from "./postgres-access-read.ts";
import { readPostgresArchiveInTransaction } from "./postgres-archive-read.ts";
import { postgresAuditReader } from "./postgres-audit-read.ts";
import {
  selectPostgresSessionArchive,
  type SessionArchive,
} from "./postgres-session-archives.ts";
import { sessionTokenHash, validSessionToken } from "./session-token.ts";

/**
 * Session and archive data must be read in the same snapshot. An archive ID
 * supplied by a client is only a selector, never proof of access.
 */
async function withSessionArchive<T>(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  now: number,
  read: (selected: SessionArchive) => Promise<T>,
): Promise<T | null> {
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

    const result = await read(selected);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function canManageArchive(selected: SessionArchive) {
  return selected.owned || isArchiveOwner(selected.user);
}

export function readPostgresArchiveForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  now = Date.now(),
) {
  return withSessionArchive(
    client,
    sessionToken,
    archiveId,
    now,
    async (selected) => {
      const archive = await readPostgresArchiveInTransaction(client, archiveId);
      return {
        archiveId: selected.archiveId,
        title: selected.title,
        owned: selected.owned,
        user: selected.user,
        revision: archive.revision,
        family: projectFamilyForUser(archive.family, selected.user),
      };
    },
  );
}

/** Audit access follows ownership or an archive-local admin membership. */
export function readPostgresAuditForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  filters: { personId?: string; actorId?: string; before?: number } = {},
  now = Date.now(),
) {
  return withSessionArchive(client, sessionToken, archiveId, now, (selected) =>
    canManageArchive(selected)
      ? postgresAuditReader(client, archiveId).list(filters)
      : Promise.resolve(null),
  );
}

/** Access management is scoped to an archive owner or administrator. */
export function readPostgresUsersForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  now = Date.now(),
) {
  return withSessionArchive(client, sessionToken, archiveId, now, (selected) =>
    canManageArchive(selected)
      ? postgresAccessReader(client, archiveId).listUsers()
      : Promise.resolve(null),
  );
}

export function readPostgresSettingsForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  now = Date.now(),
) {
  return withSessionArchive(client, sessionToken, archiveId, now, (selected) =>
    canManageArchive(selected)
      ? postgresAccessReader(client, archiveId).accessSettings()
      : Promise.resolve(null),
  );
}
