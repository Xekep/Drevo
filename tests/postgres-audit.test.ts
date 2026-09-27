import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { planArchiveAudit } from "../ops/postgres/backfill-archive-audit.ts";
import { postgresAuditReader } from "../src/server/postgres-audit-read.ts";

test("audit migration preserves deleted-person references and validates details", () => {
  const entry = {
    id: 12,
    at: "2026-09-27T00:00:00Z",
    actor_id: "deleted-account",
    actor_name: "Редактор",
    action: "Изменена карточка",
    entity: "person",
    entity_id: "deleted-person",
    label: "Карточка",
    revision: 10,
    details: '[{"field":"Имя","before":"А","after":"Б"}]',
  };
  assert.deepEqual(
    planArchiveAudit([entry], [{ entry_id: 12, person_id: "deleted-person" }]),
    {
      auditEntries: [{ ...entry, details: JSON.parse(entry.details) }],
      auditPeople: [{ entry_id: 12, person_id: "deleted-person" }],
    },
  );
  assert.throws(
    () => planArchiveAudit([{ ...entry, details: "{}" }], []),
    /должен быть массивом/,
  );
  assert.throws(
    () => planArchiveAudit([{ ...entry, id: 1.2 }], []),
    /audit_entries.id/,
  );
});

test("PostgreSQL audit page stays archive-scoped and keeps cursor semantics", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return {
        rows: Array.from({ length: 41 }, (_, i) => ({
          id: String(50 - i),
          at: "2026-09-27T00:00:00Z",
          actor_id: "user-1",
          actor_name: "Участник",
          action: "Изменение",
          entity: "person",
          entity_id: "person-1",
          label: "Карточка",
          revision: "100",
          details: [],
        })),
      };
    },
  } as unknown as pg.Client;
  const result = await postgresAuditReader(client, "archive-a").list({
    personId: "person-1",
    actorId: "user-1",
    before: 51,
  });
  assert.equal(result.items.length, 40);
  assert.equal(result.next, 11);
  assert.equal(result.items[0].revision, 100);
  assert.deepEqual(calls[0].values, ["archive-a", 51, "user-1", "person-1"]);
  assert.match(calls[0].sql, /a\.archive_id=\$1/);
  assert.match(calls[0].sql, /p\.archive_id=a\.archive_id/);
});
