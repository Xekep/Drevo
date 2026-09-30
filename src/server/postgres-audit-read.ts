import type pg from "pg";
import type { AuditEntry } from "../domain/audit.ts";

/** Read-only audit pagination with the same contract as auditStore.list. */
export function postgresAuditReader(client: pg.Client, archiveId: string) {
  return {
    async list({
      personId,
      actorId,
      before = 0,
    }: { personId?: string; actorId?: string; before?: number } = {}): Promise<{
      items: AuditEntry[];
      next: number | null;
    }> {
      const result = await client.query<{
        id: string;
        at: string;
        actor_id: string;
        actor_name: string;
        action: string;
        entity: string;
        entity_id: string;
        label: string;
        revision: string | null;
        details: AuditEntry["details"];
      }>(
        `SELECT a.id,a.at,a.actor_id,a.actor_name,a.action,a.entity,
                a.entity_id,a.label,a.revision,a.details
           FROM runtime_visible_audit_entries a
          WHERE a.archive_id=$1
            AND ($2::bigint=0 OR a.id<$2)
            AND ($3::text='' OR a.actor_id=$3)
            AND ($4::text='' OR EXISTS (
              SELECT 1 FROM archive_audit_people p
               WHERE p.archive_id=a.archive_id AND p.entry_id=a.id
                 AND p.person_id=$4))
          ORDER BY a.id DESC LIMIT 41`,
        [archiveId, before, actorId || "", personId || ""],
      );
      const items: AuditEntry[] = result.rows.slice(0, 40).map((row) => ({
        id: Number(row.id),
        at: row.at,
        actorId: row.actor_id,
        actorName: row.actor_name,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        label: row.label,
        revision: row.revision === null ? null : Number(row.revision),
        details: row.details,
      }));
      return { items, next: result.rows.length > 40 ? items.at(-1)!.id : null };
    },
  };
}
