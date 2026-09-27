import type pg from "pg";
import { ConflictError } from "../../src/server/archive-errors.ts";
import { archiveRows, type JsonRow } from "../../src/server/archive-rows.ts";
import { readPostgresArchiveInTransaction } from "../../src/server/postgres-archive-read.ts";
import { validateFamily, type Family } from "../../src/domain/index.ts";

// Migration rehearsal only. This does not implement HTTP authorization, media
// reference checks or the production audit trail and must not serve requests.
async function upsertJsonRows(
  client: pg.Client,
  table: "people" | "photos",
  archiveId: string,
  rows: JsonRow[],
) {
  await client.query(`UPDATE ${table} SET ordinal=-ordinal WHERE archive_id=$1`, [archiveId]);
  for (const [index, row] of rows.entries()) {
    await client.query(
      `INSERT INTO ${table}(archive_id,id,ordinal,data) VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT (archive_id,id) DO UPDATE SET ordinal=EXCLUDED.ordinal,data=EXCLUDED.data`,
      [archiveId, row.id, index + 1, row.data],
    );
  }
}

/** Apply one family revision inside a transaction owned by the parity checker. */
export async function writeArchiveRevisionForParity(
  client: pg.Client,
  archiveId: string,
  input: unknown,
  expectedRevision: number,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("Некорректная ожидаемая ревизия");
  const databaseName = String((await client.query("SELECT current_database() AS name")).rows[0]?.name || "");
  if (!/^drevo_migration(?:_|$)/.test(databaseName))
    throw new Error("Репетиционная запись разрешена только в migration-базе");
  const meta = await client.query(
    "SELECT revision FROM archives WHERE id=$1 FOR UPDATE",
    [archiveId],
  );
  if (!meta.rows[0]) throw new Error("Архив не найден в PostgreSQL");
  if (Number(meta.rows[0].revision) !== expectedRevision)
    throw new ConflictError("Архив изменён в другой вкладке. Обновите данные перед сохранением.");

  const previous = await readPostgresArchiveInTransaction(client, archiveId);
  const family: Family = validateFamily(input);
  const rows = archiveRows(family);

  // Move all existing ordinals out of the positive range before assigning the
  // new order. This preserves ordering without transient UNIQUE collisions.
  await client.query("DELETE FROM photo_tags WHERE archive_id=$1", [archiveId]);
  await client.query("DELETE FROM relations WHERE archive_id=$1", [archiveId]);
  await upsertJsonRows(client, "people", archiveId, rows.people);
  await upsertJsonRows(client, "photos", archiveId, rows.photos);

  for (const [index, row] of rows.relations.entries()) {
    await client.query(
      `INSERT INTO relations(archive_id,id,ordinal,source,target,type,note,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [archiveId, row.id, index + 1, row.source, row.target, row.type, row.note, row.createdBy],
    );
  }
  for (const [index, row] of rows.tags.entries()) {
    await client.query(
      `INSERT INTO photo_tags(archive_id,id,ordinal,photo_id,person_id,data)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [archiveId, row.id, index + 1, row.photoId, row.personId, row.data],
    );
  }

  // Documents and comments are retained for surviving people. Existing FK
  // cascades remove associations to deleted people/photos, as with SQLite.
  await client.query(
    "DELETE FROM photos WHERE archive_id=$1 AND NOT (id = ANY($2::text[]))",
    [archiveId, rows.photos.map((row) => row.id)],
  );
  await client.query(
    "DELETE FROM people WHERE archive_id=$1 AND NOT (id = ANY($2::text[]))",
    [archiveId, rows.people.map((row) => row.id)],
  );
  await client.query(
    `INSERT INTO history(archive_id,revision,saved_at,data)
     VALUES($1,$2,$3,$4::jsonb)
     ON CONFLICT (archive_id,revision) DO UPDATE SET data=EXCLUDED.data`,
    [archiveId, expectedRevision, new Date().toISOString(), JSON.stringify(previous.family)],
  );
  await client.query(
    `DELETE FROM history WHERE archive_id=$1 AND revision NOT IN
      (SELECT revision FROM history WHERE archive_id=$1 ORDER BY revision DESC LIMIT 50)`,
    [archiveId],
  );
  await client.query(
    "UPDATE archives SET title=$2,description=$3,demo=$4,revision=$5 WHERE id=$1",
    [archiveId, family.title, family.description, family.demo, expectedRevision + 1],
  );
  return { family, revision: expectedRevision + 1 };
}
