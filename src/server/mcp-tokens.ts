import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { ResearchScope } from "../domain/research-tools.ts";

export const MCP_SCOPES: ResearchScope[] = [
  "tree:read",
  "sources:read",
  "analysis:read",
];

export type McpTokenGrant = {
  id: string;
  createdBy: string;
  name: string;
  scopes: ResearchScope[];
  createdAt: string;
  expiresAt?: number;
  rateLimitPerMinute: number;
  boundUser?: ArchiveUser;
};

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function parseScopes(value: unknown): ResearchScope[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error("Выберите хотя бы одно разрешение");
  const scopes = [...new Set(value)];
  if (
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !MCP_SCOPES.includes(scope as ResearchScope),
    )
  )
    throw new Error("Неизвестное разрешение MCP");
  return scopes as ResearchScope[];
}

export function mcpTokenStore(db: StoreDatabase) {
  const tokenColumns = `
    t.id,t.name,t.token_hint,t.scopes,t.created_at,t.expires_at,t.created_by,
    t.revoked_at,t.last_used_at,t.rate_limit_per_minute,t.bound_user_id,
    u.name AS bound_user_name,u.role AS bound_user_role,
    u.created_at AS bound_user_created_at,u.approved AS bound_user_approved,
    u.person_id AS bound_person_id,u.tree_access AS bound_tree_access
    ${db.kind === "postgres" ? `,u.tree_role AS bound_tree_role,
      u.global_role AS bound_global_role,u.archive_owner AS bound_archive_owner` : ""}
  `;
  const listQuery = db.prepare(
    `SELECT ${tokenColumns}
       FROM mcp_tokens t
       LEFT JOIN users u ON u.id=t.bound_user_id
       ORDER BY t.created_at DESC,t.id DESC`,
    `SELECT ${tokenColumns}
       ,to_char(d.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_creator_at
       FROM mcp_tokens t
       LEFT JOIN runtime_users u ON u.id=t.bound_user_id
       LEFT JOIN deleted_account_tombstones d ON d.id=t.created_by
       ORDER BY t.created_at DESC,t.id DESC`,
  );
  const lookup = db.prepare(
    `SELECT ${tokenColumns}
       FROM mcp_tokens t
       LEFT JOIN users u ON u.id=t.bound_user_id
       WHERE t.token_hash=? AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at>?)
         AND (t.bound_user_id IS NULL OR u.approved=1)`,
    `SELECT ${tokenColumns}
       FROM mcp_tokens t
       LEFT JOIN runtime_users u ON u.id=t.bound_user_id
       LEFT JOIN deleted_account_tombstones d ON d.id=t.created_by
       WHERE t.token_hash=? AND t.revoked_at IS NULL
       AND d.id IS NULL
       AND (t.expires_at IS NULL OR t.expires_at>?)
       AND EXISTS (SELECT 1 FROM archive_memberships issuer
         JOIN archive_owners owner ON owner.archive_id=issuer.archive_id
           AND owner.user_id=issuer.user_id
         JOIN platform_admins admin ON admin.account_id=issuer.user_id
         WHERE issuer.archive_id=t.archive_id AND issuer.user_id=t.created_by
           AND issuer.approved)
       AND (t.bound_user_id IS NULL OR u.approved=1)`,
  );
  const lockedLookup = db.prepare(
    `SELECT ${tokenColumns}
       FROM mcp_tokens t
       LEFT JOIN users u ON u.id=t.bound_user_id
       WHERE t.token_hash=? AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at>?)
         AND (t.bound_user_id IS NULL OR u.approved=1)`,
    `SELECT ${tokenColumns}
       FROM mcp_tokens t
       LEFT JOIN runtime_users u ON u.id=t.bound_user_id
       LEFT JOIN deleted_account_tombstones d ON d.id=t.created_by
       WHERE t.token_hash=? AND t.revoked_at IS NULL
       AND d.id IS NULL
       AND (t.expires_at IS NULL OR t.expires_at>?)
       AND EXISTS (SELECT 1 FROM archive_memberships issuer
         JOIN archive_owners owner ON owner.archive_id=issuer.archive_id
           AND owner.user_id=issuer.user_id
         JOIN platform_admins admin ON admin.account_id=issuer.user_id
         WHERE issuer.archive_id=t.archive_id AND issuer.user_id=t.created_by
           AND issuer.approved)
       AND (t.bound_user_id IS NULL OR u.approved=1)
       FOR SHARE OF t`,
  );

  const boundUser = (row: Record<string, unknown>): ArchiveUser | undefined =>
    row.bound_user_id
      ? {
          id: String(row.bound_user_id),
          name: String(row.bound_user_name || ""),
          role: (row.bound_tree_role || row.bound_user_role) as ArchiveUser["role"],
          ...(Object.hasOwn(row, "bound_tree_role") ? {
            treeRole: row.bound_tree_role as ArchiveUser["treeRole"],
            globalRole: (row.bound_global_role || null) as ArchiveUser["globalRole"],
            archiveOwner: row.bound_archive_owner === true,
          } : {}),
          createdAt: String(row.bound_user_created_at || ""),
          approved: !!row.bound_user_approved,
          ...(row.bound_person_id
            ? { personId: String(row.bound_person_id) }
            : {}),
          treeAccess: (row.bound_tree_access ||
            "all") as ArchiveUser["treeAccess"],
        }
      : undefined;
  const touch = db.prepare(
    "UPDATE mcp_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)",
    "UPDATE mcp_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)",
  );

  const list = async () =>
    (await listQuery.all()).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      tokenHint: String(row.token_hint),
      scopes: JSON.parse(String(row.scopes)) as ResearchScope[],
      createdAt: String(row.created_at),
      ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
      createdBy: row.deleted_creator_at
        ? "deleted-account"
        : String(row.created_by),
      ...(row.revoked_at || row.deleted_creator_at
        ? { revokedAt: String(row.revoked_at || row.deleted_creator_at) }
        : {}),
      ...(row.last_used_at ? { lastUsedAt: Number(row.last_used_at) } : {}),
      rateLimitPerMinute: Number(row.rate_limit_per_minute),
      ...(boundUser(row) ? { boundUser: boundUser(row) } : {}),
    }));

  return {
    list,
    async issue(
      actor: ArchiveUser,
      value: {
        name?: unknown;
        scopes?: unknown;
        expiresDays?: unknown;
        rateLimitPerMinute?: unknown;
        boundUserId?: unknown;
      },
    ) {
      const name =
        typeof value.name === "string" ? value.name.trim().slice(0, 80) : "";
      if (!name) throw new Error("Укажите название токена");
      const scopes = parseScopes(value.scopes);
      let expiresAt: number | null = null;
      if (value.expiresDays !== undefined && value.expiresDays !== null) {
        const days = Number(value.expiresDays);
        if (!Number.isInteger(days) || days < 1 || days > 3650)
          throw new Error("Срок токена должен быть от 1 до 3650 дней");
        expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      }
      const rateLimitPerMinute =
        value.rateLimitPerMinute === undefined
          ? 60
          : Number(value.rateLimitPerMinute);
      if (
        !Number.isInteger(rateLimitPerMinute) ||
        rateLimitPerMinute < 0 ||
        rateLimitPerMinute > 600
      )
        throw new Error("Лимит MCP должен быть от 0 до 600 запросов в минуту");

      const boundUserId =
        typeof value.boundUserId === "string" && value.boundUserId.trim()
          ? value.boundUserId.trim()
          : null;
      if (boundUserId) {
        const user = await db
          .prepare(
            "SELECT approved FROM users WHERE id=?",
            "SELECT approved FROM runtime_users WHERE id=?",
          )
          .get(boundUserId);
        if (!user || !user.approved)
          throw new Error(
            "Участник для MCP-привязки не найден или заблокирован",
          );
      }

      const id = randomUUID(),
        token = `drevo_mcp_${randomBytes(32).toString("base64url")}`,
        tokenHint = `drevo_mcp_…${token.slice(-6)}`;
      await db
        .prepare(
          `INSERT INTO mcp_tokens
          (id,token_hash,token_hint,name,scopes,created_at,expires_at,created_by,
           rate_limit_per_minute,bound_user_id)
         VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?,?)`,
          "INSERT INTO mcp_tokens\n          (id,token_hash,token_hint,name,scopes,created_at,expires_at,created_by,\n           rate_limit_per_minute,bound_user_id)\n         VALUES(?,?,?,?,?,to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),?,?,?,?)",
        )
        .run(
          id,
          hash(token),
          tokenHint,
          name,
          JSON.stringify(scopes),
          expiresAt,
          actor.id,
          rateLimitPerMinute,
          boundUserId,
        );
      return {
        token,
        item: (await list()).find((item) => item.id === id)!,
      };
    },
    async revoke(id: string) {
      const result = await db
        .prepare(
          "UPDATE mcp_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revoked_at IS NULL",
          "UPDATE mcp_tokens SET revoked_at=to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') WHERE id=? AND revoked_at IS NULL",
        )
        .run(id);
      if (!result.changes)
        throw new Error("MCP-токен не найден или уже отозван");
    },
    async authenticate(
      authorization?: string,
      lockRow = false,
    ): Promise<McpTokenGrant | null> {
      const match = /^Bearer\s+(.+)$/i.exec(authorization || "");
      if (!match || !match[1].startsWith("drevo_mcp_")) return null;
      if (lockRow && db.kind === "postgres" && !db.inTransaction())
        throw new Error("Locked MCP authentication requires a transaction");
      const row = await (lockRow ? lockedLookup : lookup).get(
        hash(match[1]), Date.now());
      if (!row) return null;
      const now = Date.now();
      if (!lockRow)
        await touch.run(now, String(row.id), now - 60 * 60 * 1000);
      return {
        id: String(row.id),
        createdBy: String(row.created_by),
        name: String(row.name),
        scopes: JSON.parse(String(row.scopes)) as ResearchScope[],
        createdAt: String(row.created_at),
        ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
        rateLimitPerMinute: Number(row.rate_limit_per_minute),
        ...(boundUser(row as Record<string, unknown>)
          ? { boundUser: boundUser(row as Record<string, unknown>) }
          : {}),
      };
    },
    async bindingOptions() {
      return (
        await db
          .prepare(
            `SELECT id,name,role,created_at,approved,person_id,tree_access
           FROM users WHERE approved=1 ORDER BY name,id`,
            "SELECT id,name,role,created_at,approved,person_id,tree_access\n           FROM runtime_users WHERE approved=1 ORDER BY name,id",
          )
          .all()
      ).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        role: String(row.role),
        ...(row.person_id ? { personId: String(row.person_id) } : {}),
        treeAccess: String(row.tree_access || "all"),
      }));
    },
  };
}
