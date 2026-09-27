import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { AuditEntry } from "../../src/domain/audit.ts";
import { postgresAuditReader } from "../../src/server/postgres-audit-read.ts";

function sqliteAuditList(
  db: DatabaseSync,
  options: { personId?: string; actorId?: string; before?: number } = {},
) {
  const { personId = "", actorId = "", before = 0 } = options;
  const rows = db
    .prepare(
      `SELECT a.* FROM audit_entries a WHERE (?=0 OR a.id<?)
        AND (?='' OR a.actor_id=?)
        AND (?='' OR EXISTS (SELECT 1 FROM audit_people p
          WHERE p.entry_id=a.id AND p.person_id=?))
        ORDER BY a.id DESC LIMIT 41`,
    )
    .all(before, before, actorId, actorId, personId, personId);
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
}

export async function verifyAuditRead(
  sqlitePath: string,
  archiveId: string,
  client: pg.Client,
) {
  if (basename(sqlitePath) === "drevo.sqlite")
    throw new Error("Используйте согласованную копию SQLite, а не рабочую БД");
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (
      sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("Копия SQLite повреждена");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const reader = postgresAuditReader(client, archiveId);
      let pages = 0;
      async function compare(filter: { personId?: string; actorId?: string }) {
        let before: number | null = 0;
        while (before !== null) {
          const expected = sqliteAuditList(sqlite, { ...filter, before });
          const actual = await reader.list({ ...filter, before });
          if (!isDeepStrictEqual(actual, expected))
            throw new Error("Страница аудита PostgreSQL отличается от SQLite");
          pages++;
          before = expected.next;
        }
      }
      await compare({});
      const actors = sqlite
        .prepare("SELECT DISTINCT actor_id FROM audit_entries")
        .all()
        .map((row) => String(row.actor_id));
      for (const actorId of actors) await compare({ actorId });
      const people = sqlite
        .prepare("SELECT DISTINCT person_id FROM audit_people")
        .all()
        .map((row) => String(row.person_id));
      for (const personId of people) await compare({ personId });
      if (
        (
          await postgresAuditReader(
            client,
            `${archiveId}-isolation-probe`,
          ).list()
        ).items.length
      )
        throw new Error("Чужой архив получил доступ к аудиту");
      await client.query("COMMIT");
      return { archiveId, pages, actors: actors.length, people: people.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    sqlite.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [sqlitePath, archiveId] = process.argv.slice(2);
  if (!sqlitePath || !archiveId)
    throw new Error(
      "Использование: verify-audit-read.ts <копия.sqlite> <archive_id>",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(
      JSON.stringify(await verifyAuditRead(sqlitePath, archiveId, client)),
    );
  } finally {
    await client.end();
  }
}
