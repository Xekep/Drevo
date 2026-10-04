import type pg from "pg";
import type { ArchiveUser, Role, TreeAccess, GlobalRole, TreeRole } from "../domain/access.ts";

type UserRow = {
  id: string;
  name: string;
  created_at: string;
  last_visit_at: string | null;
  role: Role;
  approved: boolean;
  person_id: string | null;
  tree_access: TreeAccess;
  tree_role?: TreeRole;
  global_role?: GlobalRole;
  archive_owner?: boolean;
};

export function postgresUser(row: UserRow): ArchiveUser {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    ...(row.last_visit_at ? { lastVisitAt: row.last_visit_at } : {}),
    role: row.tree_role || row.role,
    ...(row.tree_role ? { treeRole: row.tree_role } : {}),
    ...(row.global_role !== undefined ? { globalRole: row.global_role } : {}),
    ...(row.archive_owner !== undefined ? { archiveOwner: row.archive_owner } : {}),
    approved: row.approved,
    ...(row.person_id ? { personId: row.person_id } : {}),
    treeAccess: row.tree_access,
  };
}

/** Every identity read is scoped to an archive membership. Not wired into HTTP yet. */
export function postgresAccessReader(client: pg.Client, archiveId: string) {
  const selectUser = `SELECT a.id,a.name,a.created_at,a.last_visit_at,
                            m.role AS tree_role,m.role,m.approved,m.person_id,m.tree_access,
                            (o.user_id IS NOT NULL) AS archive_owner,
                            CASE WHEN pa.account_id IS NOT NULL THEN 'admin'
                                 WHEN pr.account_id IS NOT NULL THEN 'researcher'
                                 ELSE NULL END AS global_role
                       FROM archive_memberships m
                       JOIN accounts a ON a.id=m.user_id
                       LEFT JOIN archive_owners o ON o.archive_id=m.archive_id AND o.user_id=m.user_id
                       LEFT JOIN platform_admins pa ON pa.account_id=m.user_id
                       LEFT JOIN platform_researchers pr ON pr.account_id=m.user_id`;
  return {
    async getUser(userId: string): Promise<ArchiveUser | null> {
      const result = await client.query<UserRow>(
        `${selectUser} WHERE m.archive_id=$1 AND m.user_id=$2`,
        [archiveId, userId],
      );
      return result.rows[0] ? postgresUser(result.rows[0]) : null;
    },
    async getSessionUser(
      tokenHash: string,
      now = Date.now(),
    ): Promise<ArchiveUser | null> {
      const result = await client.query<UserRow>(
        `${selectUser}
          JOIN account_sessions s ON s.user_id=m.user_id
         WHERE m.archive_id=$1 AND s.token_hash=$2 AND s.expires_at>$3`,
        [archiveId, tokenHash, now],
      );
      return result.rows[0] ? postgresUser(result.rows[0]) : null;
    },
    async listUsers(): Promise<ArchiveUser[]> {
      const result = await client.query<UserRow>(
        `${selectUser} WHERE m.archive_id=$1 ORDER BY a.created_at,a.id`,
        [archiveId],
      );
      return result.rows.map(postgresUser);
    },
    async accessSettings(): Promise<{
      publicTree: boolean;
      publicAlbums: boolean;
      reverseTimeline: boolean;
    } | null> {
      const result = await client.query<{
        public_tree: boolean;
        public_albums: boolean;
        reverse_timeline: boolean;
      }>(
        `SELECT s.public_tree,s.public_albums,t.reverse_timeline
           FROM archive_access_settings s
           JOIN archive_tree_settings t ON t.archive_id=s.archive_id
          WHERE s.archive_id=$1`,
        [archiveId],
      );
      const row = result.rows[0];
      return row
        ? {
            publicTree: row.public_tree,
            publicAlbums: row.public_albums,
            reverseTimeline: row.reverse_timeline,
          }
        : null;
    },
  };
}
