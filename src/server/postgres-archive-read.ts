import type pg from "pg";
import { hydrateArchive } from "./archive-hydration.ts";

/** Read-only repository for shadow comparison; no HTTP route uses it yet. */
export async function readPostgresArchive(
  client: pg.Client,
  archiveId: string,
) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await readPostgresArchiveInTransaction(client, archiveId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Caller owns the transaction and its isolation level. */
export async function readPostgresArchiveInTransaction(
  client: pg.Client,
  archiveId: string,
) {
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [archiveId]);
    const meta = await client.query(
      "SELECT title,description,demo,revision FROM archives WHERE id=$1",
      [archiveId],
    );
    if (!meta.rows[0]) throw new Error("Архив не найден в PostgreSQL");
    const people = await client.query(
      "SELECT data FROM people WHERE archive_id=$1 ORDER BY ordinal",
      [archiveId],
    );
    const relations = await client.query(
      "SELECT id,source,target,type,note,twin_kind,created_by,sources FROM relations WHERE archive_id=$1 ORDER BY ordinal",
      [archiveId],
    );
    const photos = await client.query(
      "SELECT data FROM photos WHERE archive_id=$1 ORDER BY ordinal",
      [archiveId],
    );
    const tags = await client.query(
      "SELECT photo_id,data FROM photo_tags WHERE archive_id=$1 ORDER BY ordinal",
      [archiveId],
    );
    const unions = await client.query(
      "SELECT data FROM family_unions WHERE archive_id=$1 ORDER BY ordinal",
      [archiveId],
    );
    return hydrateArchive(
      meta.rows[0],
      people.rows,
      relations.rows,
      photos.rows,
      tags.rows,
      unions.rows,
    );
}
