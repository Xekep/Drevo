import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import type { ResearchScope } from "../domain/research-tools.ts";

export const MCP_SCOPES: ResearchScope[] = [
  "tree:read",
  "sources:read",
  "analysis:read",
];

export type McpTokenGrant = {
  id: string;
  name: string;
  scopes: ResearchScope[];
  createdAt: string;
  expiresAt?: number;
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

export function mcpTokenStore(db: DatabaseSync) {
  const listQuery = db.prepare(
    `SELECT id,name,token_hint,scopes,created_at,expires_at,created_by,revoked_at,last_used_at
       FROM mcp_tokens ORDER BY created_at DESC,id DESC`,
  );
  const lookup = db.prepare(
    `SELECT id,name,scopes,created_at,expires_at
       FROM mcp_tokens
       WHERE token_hash=? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at>?)`,
  );
  const touch = db.prepare(
    "UPDATE mcp_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)",
  );

  const list = () =>
    listQuery.all().map((row) => ({
        id: String(row.id),
        name: String(row.name),
        tokenHint: String(row.token_hint),
        scopes: JSON.parse(String(row.scopes)) as ResearchScope[],
        createdAt: String(row.created_at),
        ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
        createdBy: String(row.created_by),
        ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
        ...(row.last_used_at ? { lastUsedAt: Number(row.last_used_at) } : {}),
      }));

  return {
    list,
    issue(
      actor: ArchiveUser,
      value: { name?: unknown; scopes?: unknown; expiresDays?: unknown },
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
      const id = randomUUID(),
        token = `drevo_mcp_${randomBytes(32).toString("base64url")}`,
        tokenHint = `drevo_mcp_…${token.slice(-6)}`;
      db.prepare(
        `INSERT INTO mcp_tokens
          (id,token_hash,token_hint,name,scopes,created_at,expires_at,created_by)
         VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?)`,
      ).run(
        id,
        hash(token),
        tokenHint,
        name,
        JSON.stringify(scopes),
        expiresAt,
        actor.id,
      );
      return {
        token,
        item: list().find((item) => item.id === id)!,
      };
    },
    revoke(id: string) {
      const result = db
        .prepare(
          "UPDATE mcp_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revoked_at IS NULL",
        )
        .run(id);
      if (!result.changes) throw new Error("MCP-токен не найден или уже отозван");
    },
    authenticate(authorization?: string): McpTokenGrant | null {
      const match = /^Bearer\s+(.+)$/i.exec(authorization || "");
      if (!match || !match[1].startsWith("drevo_mcp_")) return null;
      const row = lookup.get(hash(match[1]), Date.now());
      if (!row) return null;
      const now = Date.now();
      touch.run(now, String(row.id), now - 60 * 60 * 1000);
      return {
        id: String(row.id),
        name: String(row.name),
        scopes: JSON.parse(String(row.scopes)) as ResearchScope[],
        createdAt: String(row.created_at),
        ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
      };
    },
  };
}
