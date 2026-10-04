import type pg from "pg";
import type { ArchiveUser, Role, TreeAccess, GlobalRole, TreeRole } from "../domain/access.ts";
import { postgresUser } from "./postgres-access-read.ts";

type SessionArchiveRow = {
  archive_id: string;
  title: string;
  owned: boolean;
  id: string;
  name: string;
  created_at: string;
  last_visit_at: string | null;
  role: Role;
  approved: boolean;
  person_id: string | null;
  tree_access: TreeAccess;
  tree_role: TreeRole;
  global_role: GlobalRole;
  archive_owner: boolean;
};

export type SessionArchive = {
  archiveId: string;
  title: string;
  owned: boolean;
  user: ArchiveUser;
};

/** A session may be reused across trees, but rights are read per membership. */
export async function postgresSessionArchives(
  client: pg.Client,
  tokenHash: string,
  now = Date.now(),
): Promise<SessionArchive[]> {
  const result = await client.query<SessionArchiveRow>(
    `SELECT ar.id AS archive_id,ar.title,
            (o.user_id IS NOT NULL) AS owned,
            a.id,a.name,a.created_at,a.last_visit_at,
            m.role,m.role AS tree_role,m.approved,m.person_id,m.tree_access,
            CASE WHEN pa.account_id IS NOT NULL THEN 'admin'
                 WHEN pr.account_id IS NOT NULL THEN 'researcher'
                 ELSE NULL END AS global_role,
            (o.user_id IS NOT NULL) AS archive_owner
       FROM account_sessions s
       JOIN accounts a ON a.id=s.user_id
       JOIN archive_memberships m ON m.user_id=a.id
       JOIN archives ar ON ar.id=m.archive_id
       LEFT JOIN archive_owners o
         ON o.archive_id=ar.id AND o.user_id=a.id
       LEFT JOIN platform_admins pa ON pa.account_id=a.id
       LEFT JOIN platform_researchers pr ON pr.account_id=a.id
      WHERE s.token_hash=$1 AND s.expires_at>$2
      ORDER BY (o.user_id IS NOT NULL) DESC,lower(ar.title),ar.id`,
    [tokenHash, now],
  );
  return result.rows.map((row) => ({
    archiveId: row.archive_id,
    title: row.title,
    owned: row.owned,
    user: postgresUser(row),
  }));
}

/** An explicit unknown or unapproved archive never falls back to another tree. */
export async function selectPostgresSessionArchive(
  client: pg.Client,
  tokenHash: string,
  requestedArchiveId?: string,
  now = Date.now(),
): Promise<SessionArchive | null> {
  const archives = await postgresSessionArchives(client, tokenHash, now);
  if (requestedArchiveId !== undefined)
    return (
      archives.find(
        (archive) =>
          archive.archiveId === requestedArchiveId && archive.user.approved,
      ) || null
    );
  return archives.find((archive) => archive.user.approved) || null;
}
