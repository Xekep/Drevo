import { readFileSync } from "node:fs";
import type { StoreDatabase } from "./store-database.ts";
import { postgresRuntimeMigrations } from "./postgres-runtime-migrations.ts";

/** One owner per shared PostgreSQL pool. Failed probes are retryable, never cached. */
export function runtimeSchemaCoordinator() {
  let pending: Promise<void> | undefined;
  return {
    ensure(work: () => Promise<void>) {
      if (!pending) {
        const entry = Promise.resolve().then(work);
        pending = entry;
        void entry.catch(() => {
          if (pending === entry) pending = undefined;
        });
      }
      return pending;
    },
  };
}

/** Runtime extensions are global; per-archive backfills remain scoped by RLS. */
export async function initializePostgresRuntimeSchema(
  db: StoreDatabase,
  coordinator?: ReturnType<typeof runtimeSchemaCoordinator>,
) {
  if (coordinator)
    await coordinator.ensure(() => initializeGlobalRuntimeSchema(db));
  else await initializeGlobalRuntimeSchema(db);
  await initializeArchiveRuntimeSchema(db);
}

async function initializeGlobalRuntimeSchema(db: StoreDatabase) {
  for (const [query, file, options] of postgresRuntimeMigrations) {
    if ((await db.prepare("", query).get())?.present) continue;
    const sql = () =>
      readFileSync(
        new URL(`../../ops/postgres/${file}`, import.meta.url),
        "utf8",
      );
    const lock = options?.lock ?? 186743291;
    if (options?.transaction === "schema") {
      if (!db.postgresTransaction)
        throw new Error("PostgreSQL transaction unavailable");
      await db.postgresTransaction(async (client) => {
        // Take the global DDL lock before any archive row lock, including
        // a second backend opening this same archive concurrently.
        await client.query(`SELECT pg_advisory_xact_lock(${lock})`);
        if ((await client.query(query)).rows[0]?.present) return;
        await client.query(sql());
      });
      continue;
    }
    try {
      await db.transaction(async () => {
        await db.exec("", `SELECT pg_advisory_xact_lock(${lock})`);
        if ((await db.prepare("", query).get())?.present) return;
        await db.exec("", sql());
      });
    } catch (error) {
      // Only explicitly registered catalog races may be accepted, and only
      // after rollback and a fresh probe proving the entire extension exists.
      if (
        !options?.acceptConcurrentCatalogInstall ||
        (error as { code?: string }).code !== "42P07" ||
        !(await db.prepare("", query).get())?.present
      )
        throw error;
    }
  }
}

async function initializeArchiveRuntimeSchema(db: StoreDatabase) {
  // Global DDL/probes are shared, but existing messages in every other archive
  // were hidden by RLS when the migration's initial backfill ran.
  if (
    (
      await db
        .prepare(
          "",
          "SELECT 1 AS present FROM ai_chat_messages WHERE change_version=0 LIMIT 1",
        )
        .get()
    )?.present
  )
    await db.transaction(async () => {
      await db.exec(
        "",
        "UPDATE ai_chat_messages SET change_version=id WHERE change_version=0",
      );
      await db.exec(
        "",
        `UPDATE ai_chats c SET messages_version=GREATEST(c.messages_version,
        COALESCE((SELECT max(m.change_version) FROM ai_chat_messages m
          WHERE m.archive_id=c.archive_id AND m.chat_id=c.id),0))`,
      );
    });
  // The schema is global but membership RLS is per archive. Normalize each
  // archive when its runtime opens, including archives opened after migration.
  if (
    (
      await db
        .prepare(
          "",
          `SELECT 1 AS present FROM archive_memberships
    WHERE role IN ('admin','researcher') LIMIT 1`,
        )
        .get()
    )?.present
  )
    await db.transaction(async () => {
      await db
        .prepare(
          "",
          `UPDATE archive_memberships SET role='relative'
        WHERE role IN ('admin','researcher')`,
        )
        .run();
    });
  if (
    !(
      await db
        .prepare(
          "",
          `SELECT 1 AS present FROM discovery_publication_reconciled_archives
    WHERE archive_id=current_setting('drevo.archive_id', true)`,
        )
        .get()
    )?.present
  )
    await db.transaction(async () => {
      await db.exec(
        "",
        `DELETE FROM published_people published USING people p
        WHERE p.archive_id=published.archive_id AND p.id=published.person_id
          AND NOT (coalesce(p.data->>'deceased' = 'true', false) OR
                   nullif(p.data->>'death', '') IS NOT NULL)`,
      );
      await db.exec(
        "",
        `INSERT INTO discovery_publication_reconciled_archives(archive_id)
        VALUES(current_setting('drevo.archive_id', true)) ON CONFLICT DO NOTHING`,
      );
    });

  if (
    !(
      await db
        .prepare(
          "",
          `SELECT 1 AS present FROM document_citation_index_state
    WHERE archive_id=current_setting('drevo.archive_id',true)`,
        )
        .get()
    )?.present
  )
    await db.transaction(async () => {
      for (const [table, kind, field] of [
        ["people", "person", "data"],
        ["family_unions", "union", "data"],
        ["relations", "relation", "sources"],
      ])
        await db.exec(
          "",
          `INSERT INTO document_citation_refs(archive_id,document_id,kind,entity_id)
          SELECT DISTINCT entity.archive_id,ref #>> '{}','${kind}',entity.id
          FROM ${table} entity CROSS JOIN LATERAL jsonb_path_query(entity.${field},'$.**.documentId') ref
          WHERE jsonb_typeof(ref)='string' AND ref #>> '{}' <> '' ON CONFLICT DO NOTHING`,
        );
      await db.exec(
        "",
        `INSERT INTO document_citation_index_state(archive_id)
        VALUES(current_setting('drevo.archive_id',true)) ON CONFLICT DO NOTHING`,
      );
    });

  // A preview staged before the additive migration still occupies capacity
  // when its archive starts. RLS keeps this backfill within the active archive.
  if (
    (
      await db
        .prepare(
          "",
          "SELECT 1 AS present FROM workflow_stages WHERE kind='drevo' AND expires_at>? LIMIT 1",
        )
        .get(Date.now())
    )?.present
  )
    await db.transaction(async () => {
      await db.exec("", "SELECT pg_advisory_xact_lock(186743294)");
      await db
        .prepare(
          "",
          `INSERT INTO platform_portable_preview_slots(token,archive_id,expires_at)
        SELECT token,archive_id,expires_at FROM workflow_stages
        WHERE kind='drevo' AND expires_at>? ON CONFLICT(token) DO NOTHING`,
        )
        .run(Date.now());
    });
}
