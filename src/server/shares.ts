import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family } from "../domain/types.ts";
import type { ShareLink } from "../domain/shared-family.ts";
import { auditStore } from "./audit.ts";
export const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function sharesStore(db: DatabaseSync) {
  const audit = auditStore(db);
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
  });
  return {
    create(
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
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO share_links VALUES(?,?,?,?,?,?,?,?,?,NULL)",
        ).run(
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
        audit.record(
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
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { share, token };
    },
    get(token: string, now = Date.now()): ShareLink | null {
      if (!shareTokenPattern.test(token)) return null;
      const row = db
        .prepare(
          "SELECT * FROM share_links WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
        )
        .get(hash(token), new Date(now).toISOString());
      return row ? convert(row) : null;
    },
    list(before = "") {
      const cursor = Number(before || 0);
      const rows = db
        .prepare(
          "SELECT rowid AS cursor,* FROM share_links WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT 101",
        )
        .all(cursor, cursor);
      return {
        items: rows.slice(0, 100).map(convert),
        next: rows.length > 100 ? String(rows[99].cursor) : null,
      };
    },
    revoke(id: string, actor: ArchiveUser) {
      if (actor.role !== "admin")
        throw new Error("Ссылки отзывает администратор");
      const row = db.prepare("SELECT * FROM share_links WHERE id=?").get(id);
      if (!row) throw new Error("Ссылка не найдена");
      if (row.revoked_at) return;
      const share = convert(row);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE share_links SET revoked_at=? WHERE id=?").run(
          new Date().toISOString(),
          id,
        );
        audit.record(
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
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
