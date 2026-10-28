import type { Change } from "../domain/changes.ts";
import { hydrateArchive } from "./archive-hydration.ts";
import { hydrateCatalogCitations } from "./source-catalog-store.ts";
import type { StoreDatabase } from "./store-database.ts";

// Only graph/date/ownership fields cross the DB boundary for unchanged people.
// This is a validation projection, never a replacement archive snapshot.
const required = [
  "id",
  "name",
  "surname",
  "patronymic",
  "sex",
  "birth",
  "birthPlace",
  "generation",
  "column",
];
const optional = ["death", "photo", "createdBy"];
const sqlitePairs = (keys: string[]) =>
  keys.map((key) => `'${key}',json_extract(p.data,'$.${key}')`).join(",");
const postgresPairs = [...required, ...optional]
  .map((key) => `'${key}',p.data->'${key}'`)
  .join(",");

/** The archive writer transaction must already be held. Load full JSON only for
 * delta targets. A deleted person's tagged photos are included to validate
 * dangling references even if the caller forgot their tag-removal changes. */
export async function readArchiveForChanges(
  db: StoreDatabase,
  changes: Change[],
) {
  const completePeople = new Set(
    changes.filter((c) => c.collection === "people").map((c) => c.id!),
  );
  const completePhotos = new Set(
    changes.filter((c) => c.collection === "photos").map((c) => c.id!),
  );
  const deleted = changes
    .filter(
      (c) => c.collection === "people" && !c.field && c.after === undefined,
    )
    .map((c) => c.id!);
  const meta = (await db
    .prepare(
      "SELECT title,description,demo,revision FROM archive WHERE id=1",
      "SELECT title,description,demo,revision FROM archives WHERE id=current_setting('drevo.archive_id',true)",
    )
    .get())!;
  const people = await db
    .prepare(
      `SELECT CASE WHEN p.id IN (SELECT value FROM json_each(?)) THEN p.data ELSE
       json_patch(json_object(${sqlitePairs(required)},'sources',json('[]')),
         json_object(${sqlitePairs(optional)})) END AS data
       FROM people p ORDER BY rowid`,
      `SELECT CASE WHEN p.id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) THEN p.data ELSE
       jsonb_strip_nulls(jsonb_build_object(${postgresPairs},'sources','[]'::jsonb)) END AS data
       FROM people p ORDER BY ordinal`,
    )
    .all(JSON.stringify([...completePeople]));
  const relations = await db
    .prepare(
      "SELECT id,source,target,type,note,twin_kind,created_by,sources,confidence FROM relations ORDER BY rowid",
      "SELECT id,source,target,type,note,twin_kind,created_by,sources,confidence FROM relations ORDER BY ordinal",
    )
    .all();
  const unions = await db
    .prepare(
      "SELECT data FROM family_unions ORDER BY rowid",
      "SELECT data FROM family_unions ORDER BY ordinal",
    )
    .all();
  const targets = JSON.stringify([...completePhotos]),
    removed = JSON.stringify(deleted);
  const photos = await db
    .prepare(
      `SELECT id,data FROM photos WHERE id IN (SELECT value FROM json_each(?))
       OR id IN (SELECT photo_id FROM photo_tags WHERE person_id IN (SELECT value FROM json_each(?))) ORDER BY rowid`,
      `SELECT id,data FROM photos WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))
       OR id IN (SELECT photo_id FROM photo_tags WHERE person_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))) ORDER BY ordinal`,
    )
    .all(targets, removed);
  const photoIds = JSON.stringify(photos.map((row) => String(row.id)));
  const tags = photos.length
    ? await db
        .prepare(
          "SELECT photo_id,data FROM photo_tags WHERE photo_id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
          "SELECT photo_id,data FROM photo_tags WHERE photo_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) ORDER BY ordinal",
        )
        .all(photoIds)
    : [];
  const value = hydrateArchive(meta, people, relations, photos, tags, unions);
  await hydrateCatalogCitations(db, value.family);
  return { ...value, completePeople, completePhotos };
}
