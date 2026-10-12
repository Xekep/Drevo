import type pg from "pg";
import { hydrateArchive } from "./archive-hydration.ts";

// Fields used by topology, date validation, ownership and visibility. Unchanged
// biographies, albums, awards and citations are not needed for a graph delta.
const fields = [
  "id",
  "name",
  "surname",
  "patronymic",
  "maidenName",
  "sex",
  "birth",
  "death",
  "deceased",
  "birthPlace",
  "deathPlace",
  "photo",
  "createdBy",
  "generation",
  "column",
  "parentageComplete",
];

/** Caller holds the archive writer lock. Complete records are loaded only for
 * explicitly changed people; other records are a validation-only projection.
 * Never pass projected people to a full replacement writer.
 */
export async function readPostgresGraphForWrite(
  client: pg.Client,
  archiveId: string,
  completeIds: ReadonlySet<string>,
) {
  await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
    archiveId,
  ]);
  const meta = await client.query(
    "SELECT title,description,demo,revision FROM archives WHERE id=$1",
    [archiveId],
  );
  if (!meta.rows[0]) throw new Error("Архив не найден в PostgreSQL");
  const people = await client.query(
    `SELECT CASE WHEN p.id=ANY($2::text[]) THEN p.data ELSE
       COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(p.data) e
         WHERE e.key=ANY($3::text[])), '{}'::jsonb) || '{"sources":[]}'::jsonb
       END AS data FROM people p WHERE p.archive_id=$1 ORDER BY p.ordinal`,
    [archiveId, [...completeIds], fields],
  );
  const relations = await client.query(
    "SELECT id,source,target,type,note,twin_kind,created_by,sources,confidence FROM relations WHERE archive_id=$1 ORDER BY ordinal",
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
    [],
    [],
    unions.rows,
  );
}
