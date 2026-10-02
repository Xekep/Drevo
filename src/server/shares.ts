import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family } from "../domain/types.ts";
import type { ShareLink } from "../domain/shared-family.ts";
import { auditStore } from "./audit.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";
const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function sharesStore(db: StoreDatabase) {
  const audit = auditStore(db);
  async function cleanup(now = Date.now()) {
    const current = new Date(now).toISOString();
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    await db.transaction(async () => {
      await db
        .prepare(
          "DELETE FROM share_link_activity WHERE share_id IN (SELECT id FROM share_links WHERE revoked_at IS NOT NULL OR expires_at<=?)",
          "DELETE FROM share_link_activity WHERE share_id IN (SELECT id FROM share_links WHERE revoked_at IS NOT NULL OR expires_at<=?)",
        )
        .run(current);
      await db
        .prepare(
          "DELETE FROM audit_entries WHERE entity='share' AND entity_id IN (SELECT id FROM share_links WHERE (revoked_at IS NOT NULL AND revoked_at<=?) OR expires_at<=?)",
          "DELETE FROM archive_audit_entries WHERE entity='share' AND entity_id IN (SELECT id FROM share_links WHERE (revoked_at IS NOT NULL AND revoked_at<=?) OR expires_at<=?)",
        )
        .run(cutoff, cutoff);
      await db
        .prepare(
          "DELETE FROM share_links WHERE (revoked_at IS NOT NULL AND revoked_at<=?) OR expires_at<=?",
          "DELETE FROM share_links WHERE (revoked_at IS NOT NULL AND revoked_at<=?) OR expires_at<=?",
        )
        .run(cutoff, cutoff);
    });
  }
  const convert = (row: Record<string, unknown>): ShareLink => ({
    id: String(row.id),
    title: String(row.title),
    anchorId: String(row.anchor_id),
    personIds: JSON.parse(String(row.person_ids)),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    createdBy: String(row.created_by),
    createdName: String(row.created_name),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    lastVisitedAt: row.last_visited_at ? String(row.last_visited_at) : null,
  });
  return {
    cleanup,
    async create(
      input: {
        anchorId: string;
        personIds: string[];
        durationHours: number;
        title: string;
      },
      family: Family,
      actor: ArchiveUser,
      now = Date.now(),
    ) {
      if (actor.role !== "admin")
        throw new Error("Ссылки выдаёт администратор");
      const people = new Set(family.people.map((p) => p.id));
      if (
        !input ||
        !Array.isArray(input.personIds) ||
        !input.personIds.length ||
        input.personIds.length > 10000 ||
        input.personIds.some(
          (id) => typeof id !== "string" || !people.has(id),
        ) ||
        !input.personIds.includes(input.anchorId) ||
        ![1, 24, 168, 720].includes(input.durationHours) ||
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.length > 200
      )
        throw new Error("Проверьте состав семьи, название и срок ссылки");
      const token = randomBytes(32).toString("base64url");
      const share: ShareLink = {
        id: randomUUID(),
        title: input.title.trim(),
        anchorId: input.anchorId,
        personIds: [...new Set(input.personIds)],
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.durationHours * 3600000).toISOString(),
        createdBy: actor.id,
        createdName: actor.name,
        revokedAt: null,
        lastVisitedAt: null,
      };
      await db.transaction(async () => {
        if (
          db.kind === "postgres" &&
          !(actor.id === "local" && !process.env.PUBLIC_ORIGIN)
        ) {
          // db.transaction locked the archive first. Hold this membership row
          // through both INSERTs, in the same order as archive deletion.
          const membership = await db
            .prepare(
              "",
              `SELECT role,approved
            FROM archive_memberships
            WHERE archive_id=current_setting('drevo.archive_id',true)
              AND user_id=? FOR SHARE`,
            )
            .get(actor.id);
          if (
            !membership?.approved ||
            membership.role !== "admin" ||
            !actor.approved
          )
            throw new ForbiddenError("Доступ к выдаче ссылок отозван");
          await assertCurrentArchiveActor(db, actor);
        }
        await db
          .prepare(
            "INSERT INTO share_links VALUES(?,?,?,?,?,?,?,?,?,NULL)",
            "INSERT INTO share_links(id,token_hash,title,anchor_id,person_ids,created_at,expires_at,created_by,created_name,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
          )
          .run(
            share.id,
            hash(token),
            share.title,
            share.anchorId,
            JSON.stringify(share.personIds),
            share.createdAt,
            share.expiresAt,
            actor.id,
            actor.name,
          );
        await audit.record(
          {
            action: "Выдана ссылка",
            entity: "share",
            entityId: share.id,
            label: share.title,
            personIds: share.personIds,
            details: [
              { field: "Действует до", before: "", after: share.expiresAt },
              {
                field: "Количество людей",
                before: "",
                after: String(share.personIds.length),
              },
            ],
          },
          actor,
        );
      });
      return { share, token };
    },
    async get(token: string, now = Date.now()): Promise<ShareLink | null> {
      if (!shareTokenPattern.test(token)) return null;
      const row = await db
        .prepare(
          "SELECT s.*,a.last_visited_at FROM share_links s LEFT JOIN share_link_activity a ON a.share_id=s.id WHERE s.token_hash=?",
          "SELECT s.*,a.last_visited_at FROM runtime_visible_share_links s LEFT JOIN share_link_activity a ON a.share_id=s.id WHERE s.token_hash=?",
        )
        .get(hash(token));
      if (!row) return null;
      if (
        row.revoked_at ||
        String(row.expires_at) <= new Date(now).toISOString()
      ) {
        await cleanup(now);
        return null;
      }
      return convert(row);
    },
    async recordVisit(id: string, now = Date.now()) {
      const at = new Date(now).toISOString();
      const result = await db
        .prepare(
          "INSERT INTO share_link_activity(share_id,last_visited_at) SELECT id,? FROM share_links WHERE id=? AND revoked_at IS NULL AND expires_at>? ON CONFLICT(share_id) DO UPDATE SET last_visited_at=excluded.last_visited_at",
          "INSERT INTO share_link_activity(share_id,last_visited_at) SELECT id,? FROM share_links WHERE id=? AND revoked_at IS NULL AND expires_at>? ON CONFLICT(archive_id,share_id) DO UPDATE SET last_visited_at=excluded.last_visited_at",
        )
        .run(at, id, at);
      if (!result.changes) await cleanup(now);
      return result.changes > 0;
    },
    async list(before = "", now = Date.now(), actor?: ArchiveUser) {
      await cleanup(now);
      const cursor = Number(before || 0);
      return await db.transaction(async () => {
        if (db.kind === "postgres") {
          if (!actor?.approved || actor.role !== "admin")
            throw new ForbiddenError("Доступ к ссылкам отозван");
          await assertCurrentArchiveActor(db, actor);
        }
        const rows = await db
          .prepare(
            "SELECT s.rowid AS cursor,s.*,a.last_visited_at FROM share_links s LEFT JOIN share_link_activity a ON a.share_id=s.id WHERE (?=0 OR s.rowid<?) ORDER BY s.rowid DESC LIMIT 101",
            "SELECT s.ordinal AS cursor,s.*,a.last_visited_at FROM runtime_visible_share_links s LEFT JOIN share_link_activity a ON a.share_id=s.id WHERE (?=0 OR s.ordinal<?) ORDER BY s.ordinal DESC LIMIT 101",
          )
          .all(cursor, cursor);
        return {
          items: rows.slice(0, 100).map(convert),
          next: rows.length > 100 ? String(rows[99].cursor) : null,
        };
      }, true);
    },
    async revoke(id: string, actor: ArchiveUser, now = Date.now()) {
      if (actor.role !== "admin")
        throw new Error("Ссылки отзывает администратор");
      return await db.transaction(async () => {
        if (
          db.kind === "postgres" &&
          !(actor.id === "local" && !process.env.PUBLIC_ORIGIN)
        ) {
          const membership = await db
            .prepare(
              "",
              `SELECT role,approved
            FROM archive_memberships
            WHERE archive_id=current_setting('drevo.archive_id',true)
              AND user_id=? FOR SHARE`,
            )
            .get(actor.id);
          if (
            !membership?.approved ||
            membership.role !== "admin" ||
            !actor.approved
          )
            throw new ForbiddenError("Доступ к отзыву ссылок отозван");
          await assertCurrentArchiveActor(db, actor);
        }
        const row = await db
          .prepare(
            "SELECT * FROM share_links WHERE id=?",
            "SELECT * FROM share_links WHERE id=?",
          )
          .get(id);
        if (!row) throw new Error("Ссылка не найдена");
        if (row.revoked_at) return;
        const share = convert(row);
        await db
          .prepare(
            "UPDATE share_links SET revoked_at=? WHERE id=?",
            "UPDATE share_links SET revoked_at=? WHERE id=?",
          )
          .run(new Date(now).toISOString(), id);
        await db
          .prepare(
            "DELETE FROM share_link_activity WHERE share_id=?",
            "DELETE FROM share_link_activity WHERE share_id=?",
          )
          .run(id);
        await audit.record(
          {
            action: "Отозвана ссылка",
            entity: "share",
            entityId: id,
            label: share.title,
            personIds: share.personIds,
            details: [],
          },
          actor,
        );
      });
    },
  };
}
