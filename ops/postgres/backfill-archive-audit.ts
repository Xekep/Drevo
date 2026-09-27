import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { shadowRows } from "./backfill-archive-access.ts";

type Row = Record<string, unknown>;

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`Некорректное целое поле ${field}`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Некорректное поле ${field}`);
  return value;
}

export function planArchiveAudit(entries: Row[], people: Row[]) {
  const auditEntries = entries.map((row) => {
    const details = JSON.parse(string(row.details, "audit_entries.details"));
    if (!Array.isArray(details))
      throw new Error("audit_entries.details должен быть массивом");
    return {
      id: integer(row.id, "audit_entries.id"),
      at: string(row.at, "audit_entries.at"),
      actor_id: string(row.actor_id, "audit_entries.actor_id"),
      actor_name: string(row.actor_name, "audit_entries.actor_name"),
      action: string(row.action, "audit_entries.action"),
      entity: string(row.entity, "audit_entries.entity"),
      entity_id: string(row.entity_id, "audit_entries.entity_id"),
      label: string(row.label, "audit_entries.label"),
      revision:
        row.revision == null
          ? null
          : integer(row.revision, "audit_entries.revision"),
      details,
    };
  });
  const auditPeople = people.map((row) => ({
    entry_id: integer(row.entry_id, "audit_people.entry_id"),
    person_id: string(row.person_id, "audit_people.person_id"),
  }));
  return { auditEntries, auditPeople };
}

export async function backfillArchiveAuditInTransaction(
  client: pg.Client,
  archiveId: string,
) {
  const schema = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "004_archive_audit.sql"),
    "utf8",
  );
  await client.query(schema);
  if (
    (
      await client.query(
        "SELECT 1 FROM archive_audit_entries WHERE archive_id=$1 LIMIT 1",
        [archiveId],
      )
    ).rowCount
  )
    throw new Error("Аудит этого архива уже перенесён");
  const { auditEntries, auditPeople } = planArchiveAudit(
    await shadowRows(client, archiveId, "audit_entries"),
    await shadowRows(client, archiveId, "audit_people"),
  );
  for (const row of auditEntries)
    await client.query(
      `INSERT INTO archive_audit_entries
        (archive_id,id,at,actor_id,actor_name,action,entity,entity_id,label,revision,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        archiveId,
        row.id,
        row.at,
        row.actor_id,
        row.actor_name,
        row.action,
        row.entity,
        row.entity_id,
        row.label,
        row.revision,
        JSON.stringify(row.details),
      ],
    );
  for (const row of auditPeople)
    await client.query(
      "INSERT INTO archive_audit_people(archive_id,entry_id,person_id) VALUES($1,$2,$3)",
      [archiveId, row.entry_id, row.person_id],
    );
  const actualEntries = (
    await client.query(
      `SELECT id,at,actor_id,actor_name,action,entity,entity_id,label,revision,details
         FROM archive_audit_entries WHERE archive_id=$1 ORDER BY id`,
      [archiveId],
    )
  ).rows.map((row: Row) => ({
    ...row,
    id: Number(row.id),
    revision: row.revision === null ? null : Number(row.revision),
  }));
  const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
  if (!isDeepStrictEqual(actualEntries, auditEntries.sort(byId)))
    throw new Error("Записи аудита отличаются после переноса");
  const actualPeople = (
    await client.query(
      `SELECT entry_id,person_id FROM archive_audit_people
        WHERE archive_id=$1 ORDER BY entry_id,person_id`,
      [archiveId],
    )
  ).rows.map((row: Row) => ({
    entry_id: Number(row.entry_id),
    person_id: row.person_id,
  }));
  const byPerson = (
    a: { entry_id: number; person_id: string },
    b: { entry_id: number; person_id: string },
  ) => a.entry_id - b.entry_id || a.person_id.localeCompare(b.person_id);
  if (!isDeepStrictEqual(actualPeople, auditPeople.sort(byPerson)))
    throw new Error("Привязки аудита к людям отличаются после переноса");
  return { entries: auditEntries.length, people: auditPeople.length };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [archiveId] = process.argv.slice(2);
  if (!archiveId)
    throw new Error("Использование: backfill-archive-audit.ts <archive_id>");
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const result = await backfillArchiveAuditInTransaction(client, archiveId);
      await client.query("COMMIT");
      console.log(JSON.stringify(result));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}
