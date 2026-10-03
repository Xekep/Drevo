// Run after migration 076 as a PostgreSQL administrator. Each batch is one
// statement/transaction, so ordinary edits and publication revocations can
// proceed between batches. No projection row is inserted by this backfill.
import pg from "pg";
import { pathToFileURL } from "node:url";

export const discoveryNamePartsBatch = `WITH batch AS MATERIALIZED (
  SELECT d.archive_id, d.person_id,
    coalesce(btrim(p.data->>'surname'), '') AS surname_part,
    coalesce(btrim(p.data->>'name'), '') AS given_part
  FROM discovery_people d
  JOIN published_people published ON published.archive_id=d.archive_id
    AND published.person_id=d.person_id
  JOIN people p ON p.archive_id=d.archive_id AND p.id=d.person_id
  WHERE (d.surname_part IS NULL OR d.given_part IS NULL)
    AND (d.archive_id,d.person_id) > ($1,$2)
    AND (coalesce(p.data->>'deceased' = 'true', false)
      OR nullif(p.data->>'death', '') IS NOT NULL)
    AND d.name=btrim(concat_ws(' ', nullif(btrim(p.data->>'surname'), ''),
      nullif(btrim(p.data->>'name'), ''), nullif(btrim(p.data->>'patronymic'), '')))
  ORDER BY d.archive_id, d.person_id
  -- Person edits lock people before refreshing discovery_people. Lock only p
  -- here; the UPDATE acquires projection row locks after those person locks.
  LIMIT 100 FOR SHARE OF p
), updated AS (
  UPDATE discovery_people d SET surname_part=batch.surname_part,
    given_part=batch.given_part FROM batch
  WHERE d.archive_id=batch.archive_id AND d.person_id=batch.person_id
    AND (d.surname_part IS NULL OR d.given_part IS NULL)
  RETURNING d.archive_id
)
SELECT (SELECT count(*)::int FROM updated) AS changed,
  (SELECT archive_id FROM batch ORDER BY archive_id DESC,person_id DESC LIMIT 1) AS last_archive_id,
  (SELECT person_id FROM batch ORDER BY archive_id DESC,person_id DESC LIMIT 1) AS last_person_id`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--apply") throw new Error("Use --apply for the opt-in name-parts backfill");
  const client = new pg.Client();
  try {
    await client.connect();
    const role = await client.query(`SELECT rolsuper OR rolbypassrls AS allowed
      FROM pg_roles WHERE rolname=current_user`);
    if (!role.rows[0]?.allowed) throw new Error("Discovery backfill requires a role that bypasses RLS");
    await client.query("SET lock_timeout = '5s'");
    let total = 0;
    let archiveId = "", personId = "";
    for (;;) {
      const batch = (await client.query(discoveryNamePartsBatch, [archiveId,personId])).rows[0];
      total += batch.changed;
      if (batch.last_archive_id == null) break;
      archiveId = batch.last_archive_id;
      personId = batch.last_person_id;
    }
    console.log(`Updated ${total} currently published discovery name projections`);
  } finally {
    await client.end();
  }
}
