import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import {
  archiveAudit,
  type AuditDraft,
  type AuditEntry,
} from "../domain/audit.ts";
import type { Family } from "../domain/types.ts";
import type { AuditActorPage } from "../shared/audit-actors.ts";

export function auditStore(db: StoreDatabase) {
  async function record(
    draft: AuditDraft,
    actor?: ArchiveUser | Pick<ArchiveUser, "id" | "name">,
    revision: number | null = null,
  ) {
    const id = (
      await db
        .prepare(
          `INSERT INTO audit_entries(at,actor_id,actor_name,action,entity,entity_id,label,revision,details)
      VALUES(?,?,?,?,?,?,?,?,?)`,
          "INSERT INTO archive_audit_entries(at,actor_id,actor_name,action,entity,entity_id,label,revision,details)\n      VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
        )
        .run(
          new Date().toISOString(),
          actor?.id || "system",
          actor?.name || "Система",
          draft.action,
          draft.entity,
          draft.entityId,
          draft.label,
          revision,
          JSON.stringify(draft.details),
        )
    ).lastInsertRowid;
    for (const personId of new Set(draft.personIds))
      await db
        .prepare(
          "INSERT INTO audit_people(entry_id,person_id) VALUES(?,?)",
          "INSERT INTO archive_audit_people(entry_id,person_id) VALUES(?,?)",
        )
        .run(id, personId);
  }
  return {
    record,
    async actors(before = 0): Promise<AuditActorPage> {
      const query = (table: string) => `WITH latest AS (
        SELECT actor_id, MAX(id) AS latest_id FROM ${table}
        WHERE actor_id<>'system' GROUP BY actor_id
      ) SELECT a.actor_id,a.actor_name,a.id FROM ${table} a
        JOIN latest ON a.id=latest.latest_id
        WHERE (?=0 OR a.id<?) ORDER BY a.id DESC LIMIT 31`;
      const rows = await db
        .prepare(query("audit_entries"), query("runtime_visible_audit_entries"))
        .all(before, before);
      const page = rows.slice(0, 30);
      return {
        actors: page.map((row) => ({
          id: String(row.actor_id),
          name: String(row.actor_name),
        })),
        next: rows.length > 30 ? Number(page.at(-1)!.id) : null,
      };
    },
    async archive(
      before: Family,
      after: Family,
      actor?: ArchiveUser,
      revision?: number,
    ) {
      for (const draft of archiveAudit(before, after))
        await record(draft, actor, revision);
    },
    async list({
      personId,
      actorId,
      before = 0,
    }: { personId?: string; actorId?: string; before?: number } = {}) {
      const rows = await db
        .prepare(
          `SELECT a.* FROM audit_entries a WHERE (?=0 OR a.id<?)
        AND (?='' OR a.actor_id=?) AND (?='' OR EXISTS (SELECT 1 FROM audit_people p WHERE p.entry_id=a.id AND p.person_id=?))
        ORDER BY a.id DESC LIMIT 41`,
          "SELECT a.* FROM runtime_visible_audit_entries a WHERE (?=0 OR a.id<?)\n        AND (?='' OR a.actor_id=?) AND (?='' OR EXISTS (SELECT 1 FROM archive_audit_people p WHERE p.entry_id=a.id AND p.person_id=?))\n        ORDER BY a.id DESC LIMIT 41",
        )
        .all(
          before,
          before,
          actorId || "",
          actorId || "",
          personId || "",
          personId || "",
        );
      const items: AuditEntry[] = rows.slice(0, 40).map((row) => ({
        id: Number(row.id),
        at: String(row.at),
        actorId: String(row.actor_id),
        actorName: String(row.actor_name),
        action: String(row.action),
        entity: String(row.entity),
        entityId: String(row.entity_id),
        label: String(row.label),
        revision: row.revision === null ? null : Number(row.revision),
        details: JSON.parse(String(row.details)),
      }));
      return { items, next: rows.length > 40 ? items.at(-1)!.id : null };
    },
  };
}
